"""
Misst Ladezeit, Latenz und Speicherverbrauch der Backends - relevant fuer die
Frage "laeuft das im Hintergrund mit, ohne den Rechner spuerbar zu bremsen?".

Simuliert die Batch-Groessen aus extension/content.js (BATCH_SIZE=25,
MAX_CHARS=500) auf CPU (das, was bei Nutzenden ohne dedizierte GPU laeuft).

Nutzung:
    .venv/Scripts/python.exe benchmark_latency.py --backend tmr
    .venv/Scripts/python.exe benchmark_latency.py --backend desklib
    .venv/Scripts/python.exe benchmark_latency.py --backend laya
"""

import argparse
import time

import psutil

SAMPLE_TEXT = (
    "Maintaining a bicycle in good working condition requires regular attention "
    "to several key components. First, it is important to inspect the tires for "
    "proper inflation and signs of wear, as under-inflated tires can lead to "
    "reduced efficiency and increased risk of punctures. Second, the chain "
    "should be cleaned and lubricated periodically to ensure smooth shifting."
)[:500]

BATCH_SIZES = [1, 8, 25]  # 25 = extension/content.js BATCH_SIZE


def rss_mb():
    return psutil.Process().memory_info().rss / (1024 * 1024)


def bench_local(name, load_fn, score_fn):
    mem_before = rss_mb()
    t0 = time.perf_counter()
    load_fn()
    load_s = time.perf_counter() - t0
    mem_after_load = rss_mb()

    print(f"\n=== {name} ===")
    print(f"Ladezeit (kalt): {load_s:.2f}s")
    print(f"RSS vor Laden: {mem_before:.0f} MB -> nach Laden: {mem_after_load:.0f} MB (+{mem_after_load - mem_before:.0f} MB)")

    for bs in BATCH_SIZES:
        texts = [SAMPLE_TEXT] * bs
        # Warmup (erste Inferenz ist oft langsamer, z.B. durch Kernel-Autotuning)
        score_fn(texts[:1])
        t0 = time.perf_counter()
        score_fn(texts)
        dt = time.perf_counter() - t0
        print(f"Batch={bs:>3}: {dt*1000:6.0f}ms total, {dt/bs*1000:6.0f}ms/Text")

    mem_peak = rss_mb()
    print(f"RSS nach allen Batches: {mem_peak:.0f} MB")


def bench_tmr():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    model_id = "Oxidane/tmr-ai-text-detector"
    state = {}

    def load():
        state["tok"] = AutoTokenizer.from_pretrained(model_id)
        state["model"] = AutoModelForSequenceClassification.from_pretrained(model_id)
        state["model"].eval()

    def score(texts):
        with torch.no_grad():
            enc = state["tok"](texts, return_tensors="pt", truncation=True, padding=True, max_length=512)
            state["model"](**enc)

    bench_local("tmr (RoBERTa-base, 125M)", load, score)


def bench_desklib():
    import torch
    import torch.nn as nn
    from transformers import AutoConfig, AutoModel, AutoTokenizer, PreTrainedModel

    model_id = "desklib/ai-text-detector-v1.01"
    state = {}

    class DesklibAIDetectionModel(PreTrainedModel):
        config_class = AutoConfig

        def __init__(self, config):
            super().__init__(config)
            self.model = AutoModel.from_config(config)
            self.classifier = nn.Linear(config.hidden_size, 1)
            self.init_weights()

        @property
        def all_tied_weights_keys(self):
            return {}

        def forward(self, input_ids, attention_mask=None):
            outputs = self.model(input_ids, attention_mask=attention_mask)
            last = outputs[0]
            mask = attention_mask.unsqueeze(-1).expand(last.size()).float()
            pooled = torch.sum(last * mask, dim=1) / torch.clamp(mask.sum(dim=1), min=1e-9)
            return self.classifier(pooled)

    def load():
        state["tok"] = AutoTokenizer.from_pretrained(model_id)
        state["model"] = DesklibAIDetectionModel.from_pretrained(model_id)
        state["model"].eval()

    def score(texts):
        with torch.no_grad():
            enc = state["tok"](texts, padding="max_length", truncation=True, max_length=768, return_tensors="pt")
            state["model"](input_ids=enc["input_ids"], attention_mask=enc["attention_mask"])

    bench_local("desklib (DeBERTa-v3-large, 430M)", load, score)


def bench_laya():
    import requests

    server_url = "http://127.0.0.1:11500"

    def score(texts):
        state = {"candidates": [{"text": t} for t in texts]}
        questions = {
            f"c{i}": {"type": "noul", "instructions": f"Is candidates[{i}].text AI-generated?"}
            for i in range(len(texts))
        }
        resp = requests.post(f"{server_url}/v1/systemone", json={"model": "english", "state": state, "questions": questions}, timeout=90)
        resp.raise_for_status()

    print("\n=== laya (ModernBERT-large, 421M, im Docker-Container - eigener Prozess, eigener RAM) ===")
    print("Hinweis: RSS hier ist nur der Python-Client, nicht der Server. Docker-Container-Last separat mit 'docker stats laya' pruefen.")
    for bs in BATCH_SIZES:
        texts = [SAMPLE_TEXT] * bs
        score(texts[:1])  # warmup
        t0 = time.perf_counter()
        score(texts)
        dt = time.perf_counter() - t0
        print(f"Batch={bs:>3}: {dt*1000:6.0f}ms total, {dt/bs*1000:6.0f}ms/Text")


def bench_hf(model_id, max_length=512, label=None):
    """WP-06: generische Latenzmessung fuer einen Kandidaten (AutoModelForSequenceClassification)."""
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    state = {}

    def load():
        state["tok"] = AutoTokenizer.from_pretrained(model_id)
        state["model"] = AutoModelForSequenceClassification.from_pretrained(model_id)
        state["model"].eval()

    def score(texts):
        with torch.no_grad():
            enc = state["tok"](texts, return_tensors="pt", truncation=True, padding=True, max_length=max_length)
            state["model"](**enc)

    bench_local(label or model_id, load, score)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="tmr", help="laya | tmr | desklib | hf:<repo> (WP-06-Kandidat)")
    parser.add_argument("--max-length", type=int, default=512, help="nur fuer hf:<repo>")
    args = parser.parse_args()

    if args.backend == "laya":
        bench_laya()
    elif args.backend == "tmr":
        bench_tmr()
    elif args.backend == "desklib":
        bench_desklib()
    elif args.backend.startswith("hf:"):
        repo = args.backend[len("hf:") :]
        bench_hf(repo, max_length=args.max_length, label=f"{repo} (WP-06-Kandidat)")
    else:
        parser.error("--backend muss laya, tmr, desklib oder hf:<repo> sein")


if __name__ == "__main__":
    main()
