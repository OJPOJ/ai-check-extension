"""
Work package 10 of issue #46: AI counterparts for the human texts we collected ourselves
(Stack Exchange, Wikimedia, arXiv; MODEL_CONCEPT.md, "Training data"). In dataset v1 these
sources have human texts only, so a model can tell them apart by source and topic instead of
by writer. Every human text gets one prompt on its topic, for one generator of
generation.json; the AI text joins the group of its human text and therefore its side of the
split.

    titles     the question titles of the Stack Exchange answers (internet; about 100 of the 300
               requests a day the API allows without a key) -> data/sources/stackexchange/questions.jsonl
    prompts    data/generation/prompts.jsonl: per human text the task, generator, system prompt,
               temperature and target length; prints the count per generator
    run NAME   the prompts of one generator -> <out>/NAME.jsonl; continues where it stopped. Open
               models need a GPU (Colab: generate_notebook.ipynb), the APIs a key
    ingest     <out>/*.jsonl -> data/sources/generated/rows.jsonl and receipt.json: preambles and
               closing offers removed, refusals and short texts dropped

Usage (from training/):
    .venv/Scripts/python.exe dataset/generate.py titles
    .venv/Scripts/python.exe dataset/generate.py prompts
    .venv/Scripts/python.exe dataset/generate.py run claude-haiku-5-5 --limit 20     # look at a few first
    .venv/Scripts/python.exe dataset/generate.py ingest

The prompts carry human texts (continue, rewrite): like the dataset they stay private.
"""

import argparse
import json
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRAINING = HERE.parent
DATA = TRAINING / "data"
CONFIG = HERE / "generation.json"
PROMPTS = DATA / "generation" / "prompts.jsonl"
OUTPUTS = DATA / "generation" / "outputs"
QUESTIONS = DATA / "sources" / "stackexchange" / "questions.jsonl"
GENERATED = DATA / "sources" / "generated"

sys.path.insert(0, str(HERE))
from build_dataset import load_config as load_dataset_config, seeded, sentence_spans, side_of  # noqa: E402


def load_config(path: Path = CONFIG) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path) -> list:
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def human_rows(cfg: dict) -> list:
    return [r for source in cfg["sources"] for r in read_jsonl(DATA / "sources" / source / "rows.jsonl") if r["label"] == 0]


# --- titles -------------------------------------------------------------------------------

def fetch_titles() -> None:
    """Question id -> title for every Stack Exchange answer we have; continues a partial file."""
    from collect_human import SE_API, http_get

    done = {(q["site"], q["question_id"]) for q in read_jsonl(QUESTIONS)}
    wanted = defaultdict(set)
    for r in read_jsonl(DATA / "sources" / "stackexchange" / "rows.jsonl"):
        site, question = r["group"].split(":")[1:]
        if (site, int(question)) not in done:
            wanted[site].add(int(question))
    QUESTIONS.parent.mkdir(parents=True, exist_ok=True)
    with open(QUESTIONS, "a", encoding="utf-8") as out:
        for site, ids in sorted(wanted.items()):
            ids = sorted(ids)
            for i in range(0, len(ids), 100):
                data = http_get(f"{SE_API}/questions/{';'.join(map(str, ids[i:i + 100]))}",
                                {"site": site, "pagesize": 100, "filter": "default"}).json()
                for item in data.get("items", []):
                    out.write(json.dumps({"site": site, "question_id": item["question_id"], "title": unescape(item["title"])}) + "\n")
                out.flush()
                if data.get("quota_remaining", 100) < 10:
                    sys.exit("Stack Exchange quota for today is used up; run again tomorrow, it continues")
                time.sleep(data.get("backoff", 0) + 0.2)
            print(f"  {site}: {len(ids)} questions")


def unescape(text: str) -> str:
    import html

    return html.unescape(text)


# --- prompts ------------------------------------------------------------------------------

FORMAT = "Plain prose paragraphs only: no title, no headings, no lists, no Markdown."

TOPIC = {
    "qa": 'Answer this question from {site}: "{title}"',
    "sci_abstract": 'Write the abstract of a research paper titled "{title}".',
    "news": 'Write a news report with the headline "{title}".',
    "wikipedia": 'Write the text of an encyclopedia article about "{title}".',
    "howto": 'Write a section of an instructional book, on "{title}".',
    "travel": "Write a travel guide text about {title}.",
}


def target_words(text: str, cfg: dict) -> int:
    lo, hi = cfg["words"]
    return int(round(min(max(len(text.split()), lo), hi), -1))


def opening(text: str, max_words: int = 40) -> str:
    """The first sentences of a text, up to `max_words` (at least one sentence)."""
    taken = []
    for start, end in sentence_spans(text):
        sentence = text[start:end]
        if taken and len(" ".join(taken).split()) + len(sentence.split()) > max_words:
            break
        taken.append(sentence)
    return " ".join(taken)


def topic_of(row: dict, titles: dict):
    """What a text is about, or None if we do not know it (a Stack Exchange answer without its question)."""
    if row["source"] == "stackexchange":
        site, question = row["group"].split(":")[1:]
        title = titles.get((site, int(question)))
        return title and {"title": title, "site": f"{site}.stackexchange.com"}
    title = row["meta"].get("title")
    return title and {"title": title.replace("_", " "), "site": ""}


def weighted(rng: random.Random, pairs):
    values, weights = zip(*pairs)
    return rng.choices(values, weights=weights)[0]


def make_prompt(row: dict, cfg: dict, dataset_cfg: dict, titles: dict) -> dict:
    """The prompt for one human text. Everything is drawn from a hash of its id, so a prompt
    does not change when other texts are added."""
    rng = random.Random(seeded(cfg["seed"], "prompt", row["id"]))
    topic = topic_of(row, titles)
    tasks = [(t, w) for t, w in cfg["tasks"].items() if t != "write" or topic]
    task = weighted(rng, tasks)

    generators = [g for g in cfg["generators"] if not g.get("held_out")]
    held = [g for g in cfg["generators"] if g.get("held_out")]
    in_test = side_of(row["group"], dataset_cfg) == "test"
    if held and in_test and rng.random() < cfg["held_out_share"]:
        generator = rng.choice(held)
    else:
        generator = weighted(rng, [(g, g["share"]) for g in generators])

    words = target_words(row["text"], cfg)
    text = row["text"].replace("\n\n", "\n").strip()
    if task == "write":
        user = f"{TOPIC[row['domain']].format(**topic)} About {words} words. {FORMAT}"
    elif task == "continue":
        given = opening(text)
        user = f"Continue the following text with about {words} more words. Give only the continuation. {FORMAT}\n\n{given}"
    else:
        given = " ".join(text.split()[:cfg["words"][1]])
        user = f"Rewrite the following text in your own words so that it reads naturally. Keep its meaning and about its length. Give only the rewritten text. {FORMAT}\n\n{given}"
    system = weighted(rng, cfg["systems"])
    temperature = rng.choice(cfg["temperatures"]) if generator.get("temperature", True) is not False else None
    return {
        "prompt_id": row["id"], "human_id": row["id"], "group": row["group"], "source": row["source"],
        "sub_source": row["sub_source"], "domain": row["domain"], "task": task, "generator": generator["name"],
        "system": system, "user": user, "temperature": temperature, "words": words,
        "given": given if task == "continue" else None,
    }


def build_prompts(cfg: dict) -> list:
    dataset_cfg = load_dataset_config()
    titles = {(q["site"], q["question_id"]): q["title"] for q in read_jsonl(QUESTIONS)}
    if not titles:
        print("no Stack Exchange question titles (generate.py titles): their answers get no 'write' prompts")
    prompts = [make_prompt(r, cfg, dataset_cfg, titles) for r in human_rows(cfg)]
    PROMPTS.parent.mkdir(parents=True, exist_ok=True)
    with open(PROMPTS, "w", encoding="utf-8", newline="\n") as f:
        for p in prompts:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    by_generator = Counter(p["generator"] for p in prompts)
    words = Counter()
    for p in prompts:
        words[p["generator"]] += p["words"]
    print(f"{len(prompts):,} prompts -> {PROMPTS}")
    print(f"  tasks: {dict(Counter(p['task'] for p in prompts))}")
    for name, n in by_generator.most_common():
        print(f"  {name:<26} {n:>6,} prompts, about {words[name] * 1.4 / 1e6:.1f} M output tokens")
    return prompts


# --- run ----------------------------------------------------------------------------------

def messages(prompt: dict) -> list:
    out = [{"role": "system", "content": prompt["system"]}] if prompt["system"] else []
    return out + [{"role": "user", "content": prompt["user"]}]


def max_tokens(prompt: dict) -> int:
    return int(prompt["words"] * 3) + 200  # at * 2 + 100, 17% of Claude Haiku 5.5's texts were cut off


class TransformersBackend:
    """An open model on the local GPU, in batches of prompts of similar length."""

    def __init__(self, spec: dict, batch: int):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        self.torch = torch
        self.batch = batch
        self.tok = AutoTokenizer.from_pretrained(spec["model"], revision=spec.get("revision"))
        self.tok.padding_side = "left"
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        if torch.cuda.is_available():
            quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.float16) \
                if spec.get("quantise") == "4bit" else None
            self.model = AutoModelForCausalLM.from_pretrained(spec["model"], revision=spec.get("revision"), dtype=torch.float16,
                                                              quantization_config=quant, device_map="auto")
        elif spec.get("quantise"):
            raise SystemExit(f"{spec['name']} is loaded in 4 bit, which needs a GPU (generate_notebook.ipynb)")
        else:  # small models also run on a CPU, in full precision
            self.model = AutoModelForCausalLM.from_pretrained(spec["model"], revision=spec.get("revision"), dtype=torch.float32)
        self.model.eval()
        eos = self.model.generation_config.eos_token_id
        self.ends = set(eos if isinstance(eos, list) else [eos]) | {self.tok.eos_token_id}

    def chat(self, prompt: dict) -> str:
        try:
            return self.tok.apply_chat_template(messages(prompt), tokenize=False, add_generation_prompt=True)
        except Exception:  # a template without a system role: the system prompt goes in front of the request
            merged = {**prompt, "system": None, "user": f"{prompt['system']}\n\n{prompt['user']}" if prompt["system"] else prompt["user"]}
            return self.tok.apply_chat_template(messages(merged), tokenize=False, add_generation_prompt=True)

    def generate(self, prompts: list):
        """Yields (prompt, text, finish) in batches with the same temperature."""
        groups = defaultdict(list)
        for p in prompts:
            groups[p["temperature"]].append(p)
        for temperature, part in groups.items():
            part.sort(key=lambda p: len(p["user"]))
            for i in range(0, len(part), self.batch):
                batch = part[i:i + self.batch]
                enc = self.tok([self.chat(p) for p in batch], return_tensors="pt", padding=True, add_special_tokens=False).to(self.model.device)
                with self.torch.inference_mode():
                    out = self.model.generate(**enc, max_new_tokens=max(max_tokens(p) for p in batch), do_sample=temperature is not None,
                                              temperature=temperature or 1.0, top_p=0.95, pad_token_id=self.tok.pad_token_id)
                for p, ids in zip(batch, out[:, enc["input_ids"].shape[1]:]):
                    finished = any(i in self.ends for i in ids.tolist())
                    yield p, self.tok.decode(ids, skip_special_tokens=True), "stop" if finished else "length"


class AnthropicBackend:
    def __init__(self, spec: dict, workers: int):
        import anthropic

        self.anthropic = anthropic
        # an ANTHROPIC_BASE_URL that is set but empty would be taken as the address
        self.client = anthropic.Anthropic(base_url=os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com")
        self.spec = spec
        self.workers = workers

    def one(self, prompt: dict):
        params = {"model": self.spec["model"], "max_tokens": max_tokens(prompt), "thinking": {"type": "disabled"},
                  "messages": [{"role": "user", "content": prompt["user"]}]}
        if prompt["system"]:
            params["system"] = prompt["system"]
        if prompt["temperature"] is not None:
            params["temperature"] = prompt["temperature"]
        response = self.client.messages.create(**params)
        text = "".join(block.text for block in response.content if block.type == "text")
        return text, {"end_turn": "stop", "max_tokens": "length"}.get(response.stop_reason, response.stop_reason)

    def generate(self, prompts: list):
        yield from in_threads(self.one, prompts, self.workers)


class OpenAIBackend:
    """The OpenAI API and APIs compatible with it (Gemini)."""

    def __init__(self, spec: dict, workers: int):
        from openai import OpenAI

        self.client = OpenAI(api_key=os.environ.get(spec.get("key_env", "OPENAI_API_KEY")), base_url=spec.get("base_url"))
        self.spec = spec
        self.workers = workers

    def one(self, prompt: dict):
        params = {"model": self.spec["model"], "messages": messages(prompt), "max_completion_tokens": max_tokens(prompt) * 4,
                  **self.spec.get("extra", {})}
        if prompt["temperature"] is not None:
            params["temperature"] = prompt["temperature"]
        choice = self.client.chat.completions.create(**params).choices[0]
        return choice.message.content or "", choice.finish_reason


def in_threads(one, prompts: list, workers: int):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(workers) as pool:
        for p, result in zip(prompts, pool.map(lambda p: safe(one, p), prompts)):
            yield (p, *result)


def safe(one, prompt):
    try:
        return one(prompt)
    except Exception as e:  # recorded and left for the next run
        return None, f"error: {type(e).__name__}: {str(e)[:200]}"


BACKENDS = {"transformers": TransformersBackend, "anthropic": AnthropicBackend, "openai": OpenAIBackend}


def run(cfg: dict, name: str, out_dir: Path, prompts_path: Path, limit=None, batch=16, workers=8, hours=None) -> None:
    spec = next((g for g in cfg["generators"] if g["name"] == name), None)
    if spec is None:
        sys.exit(f"{name} is not a generator of generation.json: {', '.join(g['name'] for g in cfg['generators'])}")
    out = out_dir / f"{name}.jsonl"
    done = {r["prompt_id"] for r in read_jsonl(out) if r.get("text")}
    todo = [p for p in read_jsonl(prompts_path) if p["generator"] == name and p["prompt_id"] not in done]
    if limit:
        todo = todo[:: max(1, len(todo) // limit)][:limit]
    print(f"{name}: {len(done):,} done, {len(todo):,} to do -> {out}", flush=True)
    if not todo:
        return
    backend = BACKENDS[spec["backend"]](spec, batch if spec["backend"] == "transformers" else workers)
    out_dir.mkdir(parents=True, exist_ok=True)
    started, n, failed = time.time(), 0, 0
    with open(out, "a", encoding="utf-8") as f:
        for prompt, text, finish in backend.generate(todo):
            n += 1
            failed += text is None
            f.write(json.dumps({"prompt_id": prompt["prompt_id"], "generator": name, "model": spec["model"],
                                "revision": spec.get("revision"), "text": text, "finish": finish,
                                "date": datetime.now(timezone.utc).isoformat(timespec="seconds")}, ensure_ascii=False) + "\n")
            f.flush()
            if n % 50 == 0 or n == len(todo):
                rate = n / (time.time() - started)
                print(f"  {n:,}/{len(todo):,}, {failed} failed, {rate * 60:.0f} per minute, about {(len(todo) - n) / rate / 60:.0f} min left", flush=True)
            if hours and time.time() - started > hours * 3600:
                print(f"stopped after {hours} h; the same command continues", flush=True)
                return


# --- ingest -------------------------------------------------------------------------------

PREAMBLE = re.compile(r"^\s*(?:sure|certainly|of course|absolutely|okay|ok|here(?:'s| is| are))\b", re.I)
PREAMBLE_COLON = re.compile(r"^\s*here(?:'s| is| are)\b[^\n]{0,150}?:\s*", re.I)
CLOSING = re.compile(r"\n+[^\n]{0,40}\b(?:let me know|i hope this|feel free to|would you like|if you(?:'d| would) like)\b[^\n]*\s*$", re.I)
HEADING_LINE = re.compile(r"^[ \t]*#{1,6}[ \t][^\n]*\n+", re.M)
REFUSAL = re.compile(r"^\s*(?:i'?m sorry|i apologi[sz]e|i can(?:'|no)t|i am unable|i'm unable|as an ai)\b", re.I)
def clean_output(text: str, prompt: dict) -> tuple:
    """(text, reason): the generated text without what an assistant puts around it, or a reason to drop it."""
    if not text or not text.strip():
        return None, "empty"
    text = text.strip()
    if REFUSAL.match(text):
        return None, "refusal"
    for _ in range(2):  # "Sure!" and "Here is the text:" on lines of their own
        first, _, rest = text.partition("\n")
        if PREAMBLE.match(first) and rest.strip() and len(first.split()) <= 30:
            text = rest.strip()
    text = PREAMBLE_COLON.sub("", text, count=1)
    first, _, rest = text.partition("\n")
    if rest.strip() and len(first.split()) <= 12 and not first.rstrip("*# ").endswith((".", "!", "?", ":")):
        text = rest.strip()  # a title line despite the request
    text = HEADING_LINE.sub("", text)  # small models write headings despite the request
    text = CLOSING.sub("", text).strip()
    if prompt["task"] == "continue" and prompt.get("given") and text.startswith(prompt["given"][:60]):
        text = text[len(prompt["given"]):].strip()
    text = text.strip().strip('"').strip()
    return text, None


def whole_sentences(text: str) -> str:
    """The text up to the end of its last whole sentence."""
    spans = sentence_spans(text)
    if len(spans) > 1 and not text.rstrip().endswith((".", "!", "?", '"')):
        spans = spans[:-1]
    return text[: spans[-1][1]].rstrip() if spans else text


def ingest(cfg: dict, out_dir: Path) -> None:
    prompts = {p["prompt_id"]: p for p in read_jsonl(PROMPTS)}
    rows, stats = {}, Counter()
    for path in sorted(out_dir.glob("*.jsonl")):
        for r in read_jsonl(path):
            prompt = prompts.get(r["prompt_id"])
            if prompt is None or prompt["generator"] != r["generator"] or not r.get("text"):
                continue
            key = (r["generator"], prompt["task"])
            text, reason = clean_output(r["text"], prompt)
            if reason is None and r["finish"] not in ("stop", None):
                text = whole_sentences(text)  # the length limit ended it: only up to the last whole sentence
                stats[("trimmed",) + key] += 1
            if reason is None and len(text.split()) < cfg["min_words"]:
                reason = "short"
            if reason:
                stats[(reason,) + key] += 1
                continue
            stats[("kept",) + key] += 1
            rows[f"generated:{r['generator']}:{r['prompt_id']}"] = {
                "id": f"generated:{r['generator']}:{r['prompt_id']}", "source": "generated", "sub_source": prompt["task"],
                "domain": prompt["domain"], "label": 1, "generator": r["generator"], "group": prompt["group"], "text": text,
                "meta": {"human_id": prompt["human_id"], "human_source": f"{prompt['source']}/{prompt['sub_source']}",
                         "model": r["model"], "revision": r.get("revision"), "system": prompt["system"],
                         "temperature": prompt["temperature"], "date": r["date"], "licence": "generated; see the provider's terms"},
            }
    GENERATED.mkdir(parents=True, exist_ok=True)
    with open(GENERATED / "rows.jsonl", "w", encoding="utf-8", newline="\n") as f:
        for key in sorted(rows):
            f.write(json.dumps(rows[key], ensure_ascii=False) + "\n")
    receipt = {"date": datetime.now(timezone.utc).isoformat(timespec="seconds"), "rows": len(rows),
               "counts": [{"what": what, "generator": g, "task": t, "rows": n} for (what, g, t), n in sorted(stats.items())]}
    (GENERATED / "receipt.json").write_text(json.dumps(receipt, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows):,} rows -> {GENERATED / 'rows.jsonl'}")
    for (what, g, t), n in sorted(stats.items()):
        print(f"  {what:<8} {g:<26} {t:<9} {n:>6,}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["titles", "prompts", "run", "ingest"])
    ap.add_argument("generator", nargs="?", help="run: name of a generator of generation.json")
    ap.add_argument("--out", type=Path, default=OUTPUTS, help=f"folder of the generated texts (default: {OUTPUTS.relative_to(TRAINING)})")
    ap.add_argument("--prompts", type=Path, default=PROMPTS, help="run: the prompts file")
    ap.add_argument("--limit", type=int, help="run: only this many prompts, spread over all of them (to look at them first)")
    ap.add_argument("--batch", type=int, default=16, help="run, open models: prompts per batch")
    ap.add_argument("--workers", type=int, default=8, help="run, APIs: requests at the same time")
    ap.add_argument("--hours", type=float, help="run: stop after this time; the same command continues")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    cfg = load_config()
    if args.command == "titles":
        fetch_titles()
    elif args.command == "prompts":
        build_prompts(cfg)
    elif args.command == "run":
        if not args.generator:
            ap.error("which generator?")
        run(cfg, args.generator, args.out, args.prompts, args.limit, args.batch, args.workers, args.hours)
    else:
        ingest(cfg, args.out)


if __name__ == "__main__":
    main()
