"""
Work package 7 of issue #46: trains a candidate of `export_candidates.py` on our own dataset. The
encoder starts from its published weights at the pinned revision; the exit heads, the token
reduction and (for the `-ngram` variants) the n-gram table are part of the model from the first
step, so that what is trained is what `staged.py` exports and work package 6 measured
(MODEL_CONCEPT.md, "Trained the way it runs").

What a run does:
    data        per text and epoch a new excerpt of whole sentences, as long as a paragraph in the
                browser (`excerpt()` of build_dataset.py), cut to 512 tokens; batches of similar length
    loss        binary cross-entropy of every exit head, mean over the exits (`--loss last`: the
                last exit only); both classes weigh the same in total (the dataset has 1.5 AI texts
                per human one)
    validation  after every epoch, on the stored excerpts of the validation part and on the dev
                half of the 1200-text suite (`--suite`): AUROC and the share of AI texts found at 1%
                false alarms, per exit. The weights of the best epoch are kept (`model.pt`), judged
                by the suite first, whose texts come from sources we do not train on
    scores      of all exits on validation, test and the suite, as log-odds per id like the
                baselines (`scores/test.jsonl`; evaluation/evaluate_test_part.py report --run <name>)
The test part and the test half of the suite are only scored, never used to choose anything.

A run can be interrupted at any time (`--hours` stops it before a session ends); the same command
continues it from `checkpoint.pt` with the same order of texts, excerpts and learning rates.

Usage (from training/; a GPU session on Kaggle or Colab: model/train_notebook.ipynb):
    .venv/Scripts/python.exe model/train.py ettin-68m                # into data/runs/ettin-68m/
    .venv/Scripts/python.exe model/train.py ettin-68m --hours 11     # stop in time, continue with the same command
    .venv/Scripts/python.exe model/train.py ettin-68m --score        # only score validation and test again
    .venv/Scripts/python.exe model/train.py ettin-32m --rows 400 --epochs 1 --out data/runs/try   # does it run at all (CPU)
    .venv/Scripts/python.exe model/train.py --list
"""

import argparse
import json
import math
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch.nn import functional as F

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent
for _folder in (HERE, TRAINING / "dataset", TRAINING / "evaluation"):
    sys.path.insert(0, str(_folder))

from build_dataset import excerpt, load_config, normalise, seeded, sha256_file  # noqa: E402
from compare_onnx import clip_text  # noqa: E402
from evaluate_test_part import SUITE, auroc, load_rows, threshold_for  # noqa: E402
from export_candidates import CANDIDATES, levers  # noqa: E402
from staged import StagedClassifier  # noqa: E402

RUNS = TRAINING / "data" / "runs"  # gitignored

# What decides the result of a run; a checkpoint is only continued with the same values.
DEFAULTS = {
    "epochs": 2,        # the third epoch of the first run gained 0.1 points of AUROC on validation
    "batch": 32, "max_tokens": 512, "seed": 57,
    "lr": 5e-5,         # the pretrained encoder
    "head_lr": 1e-3,    # what starts random: exit heads, n-gram table
    "weight_decay": 0.01, "warmup": 0.06, "clip": 1.0,
    "loss": "all",      # "all": mean over the exits; "last": the last exit only (the other heads stay untrained)
}
CHOICES = {"loss": ("all", "last")}
CHUNK_BATCHES = 50   # batches are cut from this many batches of texts sorted by length
LOG_EVERY = 100      # steps
SAVE_MINUTES = 30
SPLITS = ("train", "validation", "test")


# --- data ---------------------------------------------------------------------------------

def check_dataset(data_dir: Path, cfg: dict, splits=SPLITS) -> dict:
    """SHA-256 of the dataset files. They have to be the ones dataset.json pins."""
    found = {s: sha256_file(data_dir / f"{s}.jsonl") for s in splits}
    wrong = [s for s in splits if found[s] != cfg["expected"]["sha256"][s]]
    if wrong:
        raise SystemExit(f"{data_dir}: {', '.join(wrong)}.jsonl is not the file of dataset {cfg['version']} (dataset.json, 'expected')")
    return found


def read_rows(path: Path, limit=None) -> list:
    """Rows without what training does not need. `scored` is the stored excerpt."""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            start, end = r["excerpt"]
            rows.append({"id": r["id"], "label": r["label"], "view": r["view"], "text": r["text"], "scored": r["text"][start:end]})
    if limit and limit < len(rows):  # the files are sorted by source: take rows from all of them
        rows = rows[:: len(rows) // limit][:limit]
    return rows


def check_suite(path: Path, cfg: dict) -> str:
    """SHA-256 of the 1200-text suite; it has to be the one the dataset was built against."""
    found = sha256_file(path)
    if found != cfg["expected"]["inputs"]["eval_suite"]:
        raise SystemExit(f"{path} is not the suite dataset {cfg['version']} was built against (dataset.json, 'expected', 'eval_suite')")
    return found


def read_suite(path: Path, cfg: dict, parts=("suite-dev",)) -> list:
    """Suite rows of the given parts. `scored` is the whole text as the extension sends it:
    normalise(), then cut to the excerpt length in characters (512 tokens is the tokeniser's cut)."""
    return [{"id": r["id"], "label": r["label"], "view": r["view"],
             "scored": clip_text(normalise(r["scored"])[0], cfg["excerpt"]["max_chars"])}
            for r in load_rows("suite", cfg, path) if r["view"] in parts]


def class_weights(rows: list) -> dict:
    """Weight of a text by its label, so that both classes weigh the same in total and a text 1 on average."""
    ai = sum(r["label"] for r in rows)
    return {1: len(rows) / (2 * ai), 0: len(rows) / (2 * (len(rows) - ai))}


def epoch_batches(rows: list, epoch: int, settings: dict, cfg: dict, skip: int = 0):
    """
    The batches of one epoch as lists of (label, text). Order, excerpts and batches depend on the
    seed and the epoch only, so an interrupted epoch continues where it stopped (`skip` batches in).
    Texts are shuffled, then every stretch of CHUNK_BATCHES batches is sorted by length before it
    is cut into batches: little padding, and still every batch from all sources.
    """
    seed, batch = settings["seed"], settings["batch"]
    order = list(range(len(rows)))
    random.Random(seeded(seed, "order", epoch)).shuffle(order)
    chunk = batch * CHUNK_BATCHES
    for at in range(skip // CHUNK_BATCHES * chunk, len(order), chunk):
        drawn = []
        for i in order[at : at + chunk]:
            r = rows[i]
            start, end = excerpt(r["text"], random.Random(seeded(seed, "excerpt", epoch, r["id"])), cfg)
            drawn.append((r["label"], r["text"][start:end]))
        drawn.sort(key=lambda d: len(d[1]))
        batches = [drawn[i : i + batch] for i in range(0, len(drawn), batch)]
        random.Random(seeded(seed, "batches", epoch, at)).shuffle(batches)
        yield from batches[skip % CHUNK_BATCHES if at == skip // CHUNK_BATCHES * chunk else 0 :]


# --- model --------------------------------------------------------------------------------

def build_model(name: str, pretrained: bool = True, seed: int = 0) -> StagedClassifier:
    """The candidate with its levers. Without `pretrained` the encoder is random too (to try the code out)."""
    from transformers import AutoConfig, AutoModel

    spec = CANDIDATES[name]
    if pretrained:
        encoder = AutoModel.from_pretrained(spec["repo"], revision=spec["revision"])
    else:
        encoder = AutoModel.from_config(AutoConfig.from_pretrained(spec["repo"], revision=spec["revision"]))
    torch.manual_seed(seed)  # the heads and the n-gram table start random
    model = StagedClassifier(encoder, **levers(name, encoder.config.num_hidden_layers))
    start_as_pretrained(model)
    return model


def start_as_pretrained(model: StagedClassifier) -> None:
    """The n-gram table adds nothing at the first step, so that the encoder starts from what it was pretrained on."""
    if model.ngram is not None:
        torch.nn.init.zeros_(model.ngram.widen.weight)


def tokeniser(name: str, max_tokens: int):
    """texts -> (input_ids, attention_mask), padded to the longest text of the call."""
    from transformers import AutoTokenizer

    spec = CANDIDATES[name]
    tok = AutoTokenizer.from_pretrained(spec["repo"], revision=spec["revision"])

    def tokenise(texts):
        enc = tok(texts, truncation=True, max_length=max_tokens, padding=True, return_tensors="pt")
        return enc["input_ids"], enc["attention_mask"]

    return tokenise


def exit_losses(logits, labels, weights):
    """Weighted binary cross-entropy per exit, (exits,). `logits` is (texts, exits)."""
    target = labels[:, None].expand_as(logits).float()
    return (F.binary_cross_entropy_with_logits(logits.float(), target, reduction="none") * weights[:, None]).mean(dim=0)


def optimiser(model, settings: dict):
    """AdamW; the encoder at `lr`, what starts random at `head_lr`, no weight decay on biases and norms."""
    groups = {}
    for name, p in model.named_parameters():
        groups.setdefault((not name.startswith("backbone."), p.ndim >= 2), []).append(p)
    return torch.optim.AdamW([
        {"params": params, "lr": settings["head_lr"] if new else settings["lr"], "weight_decay": settings["weight_decay"] if decay else 0.0}
        for (new, decay), params in groups.items()
    ])


def schedule(optim, total: int, warmup: float):
    """Linear from 0 to the learning rate over the first `warmup` of the steps, then linear to 0."""
    warm = max(1, int(total * warmup))
    return torch.optim.lr_scheduler.LambdaLR(optim, lambda step: step / warm if step < warm else max(0.0, (total - step) / max(1, total - warm)))


def autocast(device):
    """Half precision on a GPU; on a CPU it only costs time."""
    return torch.autocast(device.type, dtype=torch.float16, enabled=device.type == "cuda")


@torch.inference_mode()
def predict(model, tokenise, texts: list, batch: int, device) -> np.ndarray:
    """Logits of all exits, (texts, exits), in the order of `texts`."""
    was_training = model.training
    model.eval()
    order = sorted(range(len(texts)), key=lambda i: -len(texts[i]))
    out = np.zeros((len(texts), len(model.exits)))
    for at in range(0, len(order), batch):
        index = order[at : at + batch]
        ids, mask = tokenise([texts[i] for i in index])
        with autocast(device):
            out[index] = model(ids.to(device), mask.to(device)).float().cpu().numpy()
    model.train(was_training)
    return out


def quality(labels, logits: np.ndarray, humans=None) -> list:
    """
    Per exit: AUROC, and the share of the AI texts at or above the threshold that at most 1% of
    the human texts reach. The threshold is set on the same human texts, so the share is a
    measure to compare epochs and exits with, not a result. `humans`: logits of the human texts
    to compare with, for a group that has none.
    """
    labels = np.asarray(labels)
    out = []
    for e in range(logits.shape[1]):
        ai = logits[labels == 1, e]
        human = logits[labels == 0, e] if humans is None else humans[:, e]
        if not len(ai) or not len(human):
            out.append({"auroc": float("nan"), "detected": float("nan")})
            continue
        both = np.concatenate([ai, human])
        out.append({"auroc": auroc(np.arange(len(both)) < len(ai), both), "detected": float((ai >= threshold_for(human)).mean())})
    return out


# --- training -----------------------------------------------------------------------------

def save(path: Path, payload: dict) -> None:
    """Written next to the file and moved over it, so that an interruption leaves the old one."""
    tmp = path.with_name(path.name + ".tmp")
    torch.save(payload, tmp)
    tmp.replace(path)


def per_exit_text(exits: list, key: str) -> str:
    return "  ".join(format(q[key], ".4f" if key == "auroc" else ".1%") for q in exits)


def trained_exits(settings: dict, n_exits: int) -> list:
    """Indices of the exits whose heads the loss trains."""
    return list(range(n_exits)) if settings["loss"] == "all" else [n_exits - 1]


def selection(validation: list, suite=None, exits=None) -> list:
    """
    What an epoch is judged by, as means over the trained `exits` (default: all). With the suite:
    AUROC on its dev half first, since its texts come from sources we do not train on and the
    validation part only from those we do; the share found at 1% false alarms on validation decides
    a tie. Without: that share first, AUROC on validation second. (AUROC, not the share found, on
    the suite: 300 human texts give 1% false alarms from 3 of them.)
    """
    def mean(part, key):
        return float(np.mean([part[i][key] for i in (exits if exits is not None else range(len(part)))]))

    if suite is None:
        return [mean(validation, "detected"), mean(validation, "auroc")]
    return [mean(suite, "auroc"), mean(validation, "detected")]


def train(model, tokenise, rows: list, validation_rows: list, cfg: dict, settings: dict, out: Path, device, hours=None, log=print,
          suite_rows=None) -> bool:
    """
    Trains until all epochs are done (True) or `hours` have passed (False). Continues from
    `out/checkpoint.pt` if there is one. Writes `log.jsonl` (loss per exit, validation and the
    dev half of the suite per epoch), `checkpoint.pt` (everything to continue) and `model.pt`
    (weights of the best epoch, see `selection`).
    """
    out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    batch = settings["batch"]
    per_epoch = math.ceil(len(rows) / batch)
    total = settings["epochs"] * per_epoch
    weight_of = class_weights(rows)
    model.to(device).train()
    if settings["loss"] == "last":  # frozen, so that not even weight decay moves them
        for head in model.heads[:-1]:
            head.requires_grad_(False)
    optim = optimiser(model, settings)
    sched = schedule(optim, total, settings["warmup"])
    scaler = torch.amp.GradScaler(device.type, enabled=device.type == "cuda")
    step, best, spent = 0, None, 0.0

    checkpoint, log_path = out / "checkpoint.pt", out / "log.jsonl"
    if checkpoint.exists():
        state = torch.load(checkpoint, map_location=device, weights_only=False)
        if state["settings"] != settings:
            changed = sorted(k for k in settings if state["settings"].get(k) != settings[k])
            raise SystemExit(f"{checkpoint} was written with other settings ({', '.join(changed)}); continue with those or use another --out")
        model.load_state_dict(state["model"])
        optim.load_state_dict(state["optim"])
        sched.load_state_dict(state["sched"])
        scaler.load_state_dict(state["scaler"])
        torch.set_rng_state(state["rng"])
        if state["rng_cuda"] is not None and device.type == "cuda":
            torch.cuda.set_rng_state_all(state["rng_cuda"])
        step, best, spent = state["step"], state["best"], state["seconds"]
        # the log may be ahead of the checkpoint; what follows is written again
        lines = log_path.read_text(encoding="utf-8").splitlines(keepends=True) if log_path.exists() else []
        kept = [line for line in lines if json.loads(line)["step"] <= step]
        log_path.write_text("".join(kept), encoding="utf-8")
        log(f"continuing at step {step} of {total} ({spent / 3600:.1f} h so far)")
    elif log_path.exists():
        log_path.unlink()

    def elapsed():
        return spent + time.time() - started

    def record(entry):
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def save_checkpoint():
        save(checkpoint, {
            "settings": settings, "step": step, "best": best, "seconds": elapsed(),
            "model": model.state_dict(), "optim": optim.state_dict(), "sched": sched.state_dict(), "scaler": scaler.state_dict(),
            "rng": torch.get_rng_state(), "rng_cuda": torch.cuda.get_rng_state_all() if device.type == "cuda" else None,
        })

    log(f"{len(rows):,} texts, {per_epoch:,} steps per epoch, {settings['epochs']} epochs; class weights human {weight_of[0]:.3f}, AI {weight_of[1]:.3f}")
    running, counted, last_log, last_save, first_step = torch.zeros(len(model.exits), device=device), 0, time.time(), time.time(), step
    for epoch in range(step // per_epoch, settings["epochs"]):
        for items in epoch_batches(rows, epoch, settings, cfg, skip=step - epoch * per_epoch):
            ids, mask = tokenise([text for _, text in items])
            labels = torch.tensor([label for label, _ in items], device=device)
            weights = torch.tensor([weight_of[label] for label, _ in items], device=device)
            with autocast(device):
                logits = model(ids.to(device), mask.to(device))
            losses = exit_losses(logits, labels, weights)
            loss = losses.mean() if settings["loss"] == "all" else losses[-1]
            if not torch.isfinite(loss):
                raise SystemExit(f"step {step}: the loss is {loss.item()}; nothing is saved from this step on")
            optim.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(optim)
            torch.nn.utils.clip_grad_norm_(model.parameters(), settings["clip"])
            scaler.step(optim)
            scaler.update()
            sched.step()
            step += 1
            running += losses.detach()
            counted += 1

            if step % LOG_EVERY == 0 or step == total:
                per_exit = (running / counted).tolist()
                rate = (step - first_step) / (time.time() - started)
                record({"step": step, "epoch": epoch, "loss": sum(per_exit) / len(per_exit), "loss_per_exit": per_exit,
                        "lr": sched.get_last_lr()[0], "seconds": elapsed()})
                if time.time() - last_log > 60 or step == total:
                    last_log = time.time()
                    log(f"step {step:,}/{total:,}  loss per exit {' '.join(f'{x:.3f}' for x in per_exit)}  "
                        f"{rate * batch:.0f} texts/s, about {(total - step) / rate / 60:.0f} min of training left")
                running.zero_()
                counted = 0
            if step % per_epoch == 0:
                break  # the end of an epoch is handled below, once
            if time.time() - last_save > SAVE_MINUTES * 60:
                save_checkpoint()
                last_save = time.time()
            if hours and time.time() - started > hours * 3600:
                save_checkpoint()
                log(f"stopped after {hours} h at step {step:,} of {total:,}; the same command continues")
                return False

        validation = quality([r["label"] for r in validation_rows],
                             predict(model, tokenise, [r["scored"] for r in validation_rows], batch * 2, device))
        suite = suite_rows and quality([r["label"] for r in suite_rows],
                                       predict(model, tokenise, [r["scored"] for r in suite_rows], batch * 2, device))
        value = selection(validation, suite or None, trained_exits(settings, len(model.exits)))
        record({"step": step, "epoch": epoch, "validation": validation, **({"suite_dev": suite} if suite else {}),
                "selection": value, "seconds": elapsed()})
        log(f"epoch {epoch + 1}: validation AUROC per exit {per_exit_text(validation, 'auroc')}, found at 1% false alarms {per_exit_text(validation, 'detected')}")
        if suite:
            log(f"         suite-dev  AUROC per exit {per_exit_text(suite, 'auroc')}, found at 1% false alarms {per_exit_text(suite, 'detected')}")
        if best is None or value > best["selection"]:
            best = {"epoch": epoch, "step": step, "selection": value, "validation": validation, **({"suite_dev": suite} if suite else {})}
            save(out / "model.pt", {"model": model.state_dict(), **best})
        save_checkpoint()
        last_save = time.time()
        if hours and time.time() - started > hours * 3600 and epoch + 1 < settings["epochs"]:
            log(f"stopped after {hours} h at the end of epoch {epoch + 1}; the same command continues")
            return False
    return True


# --- scores -------------------------------------------------------------------------------

def score(model, tokenise, data_dir: Path, out: Path, device, batch: int, limit=None, log=print, suite_path=None) -> dict:
    """
    Scores validation and test with `out/model.pt` and writes per split `scores/<split>.jsonl`:
    per id the log-odds of all exits (`exits`) and of the last one (`logit`, the field the
    baselines have). Returns and writes `scores/summary.json`: AUROC and the share found at 1%
    false alarms per exit, for each split and each view of it. With `suite_path` the whole suite
    goes to `scores/suite.jsonl` as well; the summary and the log show its dev half only.
    """
    best = torch.load(out / "model.pt", map_location=device, weights_only=False)
    model.load_state_dict(best["model"])
    model.to(device)
    (out / "scores").mkdir(exist_ok=True)
    summary = {"epoch": best["epoch"], "step": best["step"], "exits": model.exits}
    for split in ("validation", "test"):
        rows = read_rows(data_dir / f"{split}.jsonl", limit)
        logits = predict(model, tokenise, [r["scored"] for r in rows], batch, device)
        with open(out / "scores" / f"{split}.jsonl", "w", encoding="utf-8") as f:
            for r, values in zip(rows, logits.tolist()):
                f.write(json.dumps({"id": r["id"], "logit": values[-1], "exits": values}) + "\n")
        labels = np.array([r["label"] for r in rows])
        views = np.array([r["view"] for r in rows])
        # a view without human texts (the held-out generators) is compared with those of `main`
        main_humans = logits[(views == "main") & (labels == 0)]
        summary[split] = {"all": {"human": int((labels == 0).sum()), "ai": int(labels.sum()), "exits": quality(labels, logits)}}
        for view in sorted(set(views)):
            part = views == view
            humans = None if (labels[part] == 0).any() else main_humans
            summary[split][view] = {"human": int((labels[part] == 0).sum()), "ai": int(labels[part].sum()),
                                    "exits": quality(labels[part], logits[part], humans)}
        log(f"\n{split} (weights of epoch {best['epoch'] + 1}): AUROC | found at 1% false alarms, per exit after layer {'/'.join(map(str, model.exits))}\n")
        for name, part in summary[split].items():
            log(f"  {name:<20} {part['human']:>6,} human {part['ai']:>6,} AI   "
                + per_exit_text(part["exits"], "auroc") + "  |  " + per_exit_text(part["exits"], "detected"))
    if suite_path:
        cfg = load_config()
        rows = read_suite(suite_path, cfg, parts=("suite-dev", "suite-test"))
        logits = predict(model, tokenise, [r["scored"] for r in rows], batch, device)
        with open(out / "scores" / "suite.jsonl", "w", encoding="utf-8") as f:
            for r, values in zip(rows, logits.tolist()):
                f.write(json.dumps({"id": r["id"], "logit": values[-1], "exits": values}) + "\n")
        dev = np.array([r["view"] == "suite-dev" for r in rows])
        labels = np.array([r["label"] for r in rows])[dev]
        summary["suite-dev"] = {"human": int((labels == 0).sum()), "ai": int(labels.sum()), "exits": quality(labels, logits[dev])}
        part = summary["suite-dev"]
        log(f"\n  {'suite-dev':<20} {part['human']:>6,} human {part['ai']:>6,} AI   "
            + per_exit_text(part["exits"], "auroc") + "  |  " + per_exit_text(part["exits"], "detected"))
    (out / "scores" / "summary.json").write_text(json.dumps(summary, indent=1).replace("NaN", "null"), encoding="utf-8")
    return summary


# --- run ----------------------------------------------------------------------------------

def commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=TRAINING, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def main():
    names = [n for n, spec in CANDIDATES.items() if "anchor" not in spec]
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", nargs="?", choices=names, metavar="candidate", help="see --list")
    ap.add_argument("--list", action="store_true", help="print the candidates and stop")
    ap.add_argument("--data", type=Path, help="folder with train/validation/test.jsonl (default: data/dataset/<version>)")
    ap.add_argument("--out", type=Path, help="folder of the run (default: data/runs/<candidate>)")
    ap.add_argument("--resume-from", type=Path, help="folder of an earlier session of this run; its files are copied to --out if that has no checkpoint")
    ap.add_argument("--hours", type=float, help="stop and save after this time; the same command continues")
    ap.add_argument("--score", action="store_true", help="only score validation and test with the model.pt of the run")
    ap.add_argument("--rows", type=int, help="train on this many texts only and validate and score on a quarter as many, to try a run out")
    ap.add_argument("--random-weights", action="store_true", help="do not load the pretrained encoder (to try the code out)")
    ap.add_argument("--suite", type=Path, help=f"the 1200-text suite; its dev half chooses the epoch (default: {SUITE.relative_to(TRAINING)} if it exists)")
    ap.add_argument("--no-suite", action="store_true", help="choose the epoch on validation alone")
    ap.add_argument("--device", help="default: cuda if there is one")
    for key, value in DEFAULTS.items():
        ap.add_argument(f"--{key.replace('_', '-')}", type=type(value), default=value, choices=CHOICES.get(key), help=f"default: {value}")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    if args.list:
        for name in names:
            spec = CANDIDATES[name]
            note = "n-gram table and an exit on the embeddings" if spec.get("ngram") else                 {"early": "tokens pooled after the first layer too", "twice": "tokens pooled after the second exit too"}.get(spec.get("reduce"), "")
            print(f"{name:<22} {spec['repo']}@{spec['revision'][:7]}" + (f"  ({note})" if note else ""))
        return
    if not args.name:
        ap.error("which candidate? (--list)")

    cfg = load_config()
    data_dir = args.data or TRAINING / "data" / "dataset" / cfg["version"]
    out = args.out or RUNS / args.name
    out.mkdir(parents=True, exist_ok=True)
    if args.resume_from and not (out / "checkpoint.pt").exists():
        for name in ("checkpoint.pt", "model.pt", "log.jsonl", "run.json"):
            if (args.resume_from / name).exists():
                shutil.copy2(args.resume_from / name, out / name)
    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    checksums = check_dataset(data_dir, cfg)
    suite_path = None if args.no_suite else args.suite or (SUITE if SUITE.exists() else None)
    if args.suite and not args.suite.exists():
        raise SystemExit(f"--suite {args.suite} does not exist")
    if suite_path:
        checksums["suite"] = check_suite(suite_path, cfg)
    else:
        print("no suite: the epoch is chosen on validation alone (texts from the sources we train on)", flush=True)
    settings = {"candidate": args.name, "pretrained": not args.random_weights, "rows": args.rows,
                "dataset": cfg["version"], "train_sha256": checksums["train"], "suite": bool(suite_path),
                **{k: getattr(args, k) for k in DEFAULTS}}
    model = build_model(args.name, pretrained=not args.random_weights, seed=args.seed)
    tokenise = tokeniser(args.name, args.max_tokens)
    spec = CANDIDATES[args.name]
    print(f"{args.name}: exits after layer {'/'.join(map(str, model.exits))}, tokens pooled after layer "
          f"{'/'.join(map(str, model.reduce_after))}, {sum(p.numel() for p in model.parameters()) / 1e6:.1f} M parameters, {device}", flush=True)

    def log(message):
        print(message, flush=True)

    if not args.score:
        run = {
            "settings": settings, "repo": spec["repo"], "revision": spec["revision"],
            "exits": model.exits, "reduce_after": list(model.reduce_after), "ngram": list(model.ngram.table.weight.shape) if model.ngram else None,
            "parameters": sum(p.numel() for p in model.parameters()), "dataset_sha256": checksums, "commit": commit(),
            "versions": {"torch": torch.__version__, "transformers": __import__("transformers").__version__},
            "device": torch.cuda.get_device_name(0) if device.type == "cuda" else "cpu",
        }
        (out / "run.json").write_text(json.dumps(run, indent=1) + "\n", encoding="utf-8")
        rows = read_rows(data_dir / "train.jsonl", args.rows)
        validation_rows = read_rows(data_dir / "validation.jsonl", args.rows and max(1, args.rows // 4))
        suite_rows = read_suite(suite_path, cfg) if suite_path else None
        if not train(model, tokenise, rows, validation_rows, cfg, settings, out, device, args.hours, log, suite_rows):
            return
        del rows
    summary = score(model, tokenise, data_dir, out, device, args.batch * 2, args.rows and max(1, args.rows // 4), log, suite_path)
    run = json.loads((out / "run.json").read_text(encoding="utf-8"))
    run["best"] = {"epoch": summary["epoch"], "step": summary["step"]}
    (out / "run.json").write_text(json.dumps(run, indent=1) + "\n", encoding="utf-8")
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
