"""
The model of issue #46 as it is measured (work package 6) and later trained (work package 7): a
pretrained encoder with classifier heads after some of its layers (early exit) and, optionally,
half as many tokens from one layer on (token reduction). Concept: MODEL_CONCEPT.md, "Architecture",
levers 1 and 2.

The encoder is a Hugging Face model; its layers are called one by one, so that the same code runs
all layers at once (training, `StagedClassifier.forward`) or only the layers up to the next exit
(`Stage`, one ONNX graph per stage: the browser stops calling stages once a head is confident).
"""

import torch
from torch import nn

# Layers called one by one need what the encoder otherwise prepares once per forward pass
# (attention masks, positions). One adapter per model family does that; `context` is computed
# again when token reduction has changed the sequence.


def additive_mask(mask, dtype):
    """(batch, tokens) with 1 for a token and 0 for padding -> (batch, 1, 1, tokens), added to the attention scores."""
    return (1.0 - mask[:, None, None, :].to(dtype)) * torch.finfo(dtype).min


class BertBackbone(nn.Module):
    """BERT, RoBERTa and the MiniLM models published in their format."""

    def __init__(self, model):
        super().__init__()
        self.model = model
        self.num_layers = len(model.encoder.layer)

    def embed(self, input_ids, mask):
        return self.model.embeddings(input_ids=input_ids)

    def context(self, hidden, mask):
        return additive_mask(mask, hidden.dtype)

    def layer(self, i, hidden, ctx):
        out = self.model.encoder.layer[i](hidden, ctx)
        return out[0] if isinstance(out, tuple) else out

    def finish(self, hidden):
        return hidden


class AlbertBackbone(nn.Module):
    """ALBERT: narrow embeddings widened once, and layers that share their weights in groups."""

    def __init__(self, model):
        super().__init__()
        self.model = model
        self.num_layers = model.config.num_hidden_layers

    def embed(self, input_ids, mask):
        return self.model.encoder.embedding_hidden_mapping_in(self.model.embeddings(input_ids=input_ids))

    def context(self, hidden, mask):
        return additive_mask(mask, hidden.dtype)

    def layer(self, i, hidden, ctx):
        groups = self.model.encoder.albert_layer_groups
        return groups[i * len(groups) // self.num_layers](hidden, ctx)

    def finish(self, hidden):
        return hidden


class DebertaBackbone(nn.Module):
    """DeBERTa-v2/v3: relative positions, shared by all layers."""

    def __init__(self, model):
        super().__init__()
        if model.encoder.conv is not None:
            raise ValueError("DeBERTa with a convolution after the first layer is not supported")
        self.model = model
        self.num_layers = len(model.encoder.layer)

    def embed(self, input_ids, mask):
        return self.model.embeddings(input_ids=input_ids, mask=mask)

    def context(self, hidden, mask):
        enc = self.model.encoder
        return enc.get_attention_mask(mask), enc.get_rel_pos(hidden), enc.get_rel_embedding()

    def layer(self, i, hidden, ctx):
        attention_mask, relative_pos, rel_embeddings = ctx
        out = self.model.encoder.layer[i](
            hidden, attention_mask, query_states=None, relative_pos=relative_pos, rel_embeddings=rel_embeddings
        )
        return out[0] if isinstance(out, tuple) else out

    def finish(self, hidden):
        return hidden


class ModernBertBackbone(nn.Module):
    """ModernBERT, Ettin, mmBERT: rotary positions, most layers attend only within a window."""

    def __init__(self, model):
        super().__init__()
        self.model = model
        self.num_layers = len(model.layers)
        self.window = model.config.sliding_window  # tokens to each side

    def embed(self, input_ids, mask):
        return self.model.embeddings(input_ids=input_ids)

    def context(self, hidden, mask):
        full = additive_mask(mask, hidden.dtype)
        position = torch.arange(hidden.shape[1], device=hidden.device)
        far = (position[None, :] - position[:, None]).abs() > self.window
        masks = {
            "full_attention": full,
            "sliding_attention": full.expand(-1, -1, hidden.shape[1], -1).masked_fill(far, torch.finfo(hidden.dtype).min),
        }
        rotary = {t: self.model.rotary_emb(hidden, position[None, :], t) for t in set(self.model.config.layer_types)}
        return masks, rotary

    def layer(self, i, hidden, ctx):
        masks, rotary = ctx
        layer = self.model.layers[i]
        return layer(hidden, attention_mask=masks[layer.attention_type], position_embeddings=rotary[layer.attention_type])

    def finish(self, hidden):
        return self.model.final_norm(hidden)


BACKBONES = {
    "bert": BertBackbone, "roberta": BertBackbone, "albert": AlbertBackbone, "deberta-v2": DebertaBackbone,
    "modernbert": ModernBertBackbone,
}


def backbone_for(model):
    """The adapter for a Hugging Face encoder (`AutoModel`, not a model with a task head)."""
    family = model.config.model_type
    if family not in BACKBONES:
        raise ValueError(f"No adapter for model type {family!r}; known: {sorted(BACKBONES)}")
    return BACKBONES[family](model)


def pool_tokens(hidden, mask):
    """
    Token reduction 2:1. The first token stays; after it every two neighbours become their mean
    (padding does not count, a pair of padding stays padding). n tokens become 1 + ceil((n - 1) / 2).
    """
    weight = mask.to(hidden.dtype).unsqueeze(-1)
    rest, rest_weight = (hidden * weight)[:, 1:], weight[:, 1:]
    left, left_weight = rest[:, 0::2], rest_weight[:, 0::2]
    # with an odd number the last token has no partner: pair it with nothing
    pairs = left.shape[1]
    right = torch.cat([rest[:, 1::2], torch.zeros_like(left[:, :1])], dim=1)[:, :pairs]
    right_weight = torch.cat([rest_weight[:, 1::2], torch.zeros_like(left_weight[:, :1])], dim=1)[:, :pairs]
    count = left_weight + right_weight
    pooled = (left + right) / count.clamp(min=1.0)
    hidden = torch.cat([hidden[:, :1], pooled], dim=1)
    mask = torch.cat([mask[:, :1], (count.squeeze(-1) > 0).to(mask.dtype)], dim=1)
    return hidden, mask


class ExitHead(nn.Module):
    """One score from the hidden states of a layer: normalise, mean over the tokens, one logit (AI above 0)."""

    def __init__(self, hidden_size):
        super().__init__()
        self.norm = nn.LayerNorm(hidden_size)
        self.out = nn.Linear(hidden_size, 1)

    def forward(self, hidden, mask):
        weight = mask.to(hidden.dtype).unsqueeze(-1)
        mean = (self.norm(hidden) * weight).sum(dim=1) / weight.sum(dim=1).clamp(min=1.0)
        return self.out(mean).squeeze(-1)


def default_exits(num_layers):
    """Exits after a third, two thirds and all layers."""
    return sorted({max(1, round(num_layers / 3)), max(1, round(2 * num_layers / 3)), num_layers})


class StagedClassifier(nn.Module):
    """
    `exits`: number of layers computed before each head, ascending; the last one must be all layers.
    `reduce_after`: tokens are pooled 2:1 after this many layers (None: never).
    """

    def __init__(self, encoder, exits=None, reduce_after=None):
        super().__init__()
        self.backbone = backbone_for(encoder)
        layers = self.backbone.num_layers
        self.exits = list(exits) if exits else default_exits(layers)
        if self.exits != sorted(set(self.exits)) or self.exits[0] < 1 or self.exits[-1] != layers:
            raise ValueError(f"exits must ascend and end at the last layer ({layers}): {self.exits}")
        if reduce_after is not None and not 1 <= reduce_after < layers:
            raise ValueError(f"reduce_after must be between 1 and {layers - 1}: {reduce_after}")
        self.reduce_after = reduce_after
        self.heads = nn.ModuleList(ExitHead(encoder.config.hidden_size) for _ in self.exits)

    def embed(self, input_ids, mask):
        return self.backbone.embed(input_ids, mask)

    def run_layers(self, hidden, mask, start, end):
        """Layers start..end-1 (0-based). `hidden` and `mask` are as they were after layer start-1."""
        ctx = None
        for i in range(start, end):
            if i == self.reduce_after:
                hidden, mask = pool_tokens(hidden, mask)
                ctx = None
            if ctx is None:
                ctx = self.backbone.context(hidden, mask)
            hidden = self.backbone.layer(i, hidden, ctx)
        return hidden, mask

    def score(self, exit_index, hidden, mask):
        if exit_index == len(self.exits) - 1:
            hidden = self.backbone.finish(hidden)
        return self.heads[exit_index](hidden, mask)

    def forward(self, input_ids, attention_mask):
        """The logits of all exits, (batch, exits). Training uses all of them, the last one is the full model."""
        hidden, mask = self.embed(input_ids, attention_mask), attention_mask
        logits, start = [], 0
        for n, end in enumerate(self.exits):
            hidden, mask = self.run_layers(hidden, mask, start, end)
            logits.append(self.score(n, hidden, mask))
            start = end
        return torch.stack(logits, dim=-1)


class Stage(nn.Module):
    """
    The part of the model between two exits, for export. Stage 0 takes `input_ids`, the later ones
    the `hidden` output of the stage before; all take and return `attention_mask`, which token
    reduction shortens. Returns (logit, hidden, attention_mask); the last stage only the logit.
    """

    def __init__(self, model, index):
        super().__init__()
        self.model, self.index = model, index
        self.start = model.exits[index - 1] if index else 0
        self.end = model.exits[index]
        self.last = index == len(model.exits) - 1

    def forward(self, hidden, attention_mask):
        if self.index == 0:
            hidden = self.model.embed(hidden, attention_mask)
        hidden, mask = self.model.run_layers(hidden, attention_mask, self.start, self.end)
        logit = self.model.score(self.index, hidden, mask)
        return logit if self.last else (logit, hidden, mask)


class Full(nn.Module):
    """All layers in one graph and only the last head: the model without early exit, as the baseline of the measurement."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        hidden, mask = self.model.run_layers(self.model.embed(input_ids, attention_mask), attention_mask, 0, self.model.exits[-1])
        return self.model.score(len(self.model.exits) - 1, hidden, mask)
