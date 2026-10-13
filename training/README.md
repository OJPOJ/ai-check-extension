# Training and evaluation

Everything around the models that is not the extension itself. Four components, each with its
own README:

| Folder | What | Status |
|---|---|---|
| [`dataset/`](dataset/README.md) | Data for our own detector model (issue #46): sources, own collection of human texts, the cleaned and split dataset with its frozen test part | in progress |
| [`evaluation/`](evaluation/README.md) | Measurements on the models in use: eval suite, thresholds, false alarms, latency, ONNX comparison, reference set of the extension | in use |
| [`model/`](model/README.md) | Our own detector model (issue #46): the encoder with early exit and token reduction, export of the candidates to ONNX and their latency in the browser, the training script | in progress |
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

They cover the dataset component, the baselines, the model definition and the training script, and
use small texts and tiny models built in the tests, not the real data.
