# Training and evaluation

Everything around the models that is not the extension itself. Three components, each with its
own README:

| Folder | What | Status |
|---|---|---|
| [`dataset/`](dataset/README.md) | Data for our own detector model (issue #46): sources, own collection of human texts, the cleaned and split dataset with its frozen test part | in progress |
| [`evaluation/`](evaluation/README.md) | Measurements on the models in use: eval suite, thresholds, false alarms, latency, ONNX comparison, reference set of the extension | in use |
| [`finetune/`](finetune/README.md) | Fine-tuning of the Laya model on HC3 and the import of feedback | paused |

Documents at this level, referred to from the rest of the repository:

- [`MODEL_CONCEPT.md`](MODEL_CONCEPT.md): concept of our own model, training data and licences.
- [`MODEL_SEARCH.md`](MODEL_SEARCH.md): search for and comparison of existing models.
- [`EVAL_RESULTS.md`](EVAL_RESULTS.md): measurement results.

## Setup

```
cd training
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

All commands in the READMEs run from `training/`, e.g. `.venv/Scripts/python.exe dataset/build_dataset.py`.
`data/` holds everything that is downloaded or built and is gitignored; no dataset text is in the
repository.

## Tests

```
.venv/Scripts/python.exe -m unittest discover -s tests
```

They cover the dataset component and use small texts written in the tests, not the real data.
