# Open models on Modal

Two demo backends run on Modal and scale to zero when idle. Nothing here
is needed to run the app: without them the browser voice speaks and the
client cards open without private briefs.

| App | File | GPU | Endpoint |
| --- | --- | --- | --- |
| Seamless voice | `modal/seamless.py` | T4 | `web_speak` |
| Glimmer briefs | `modal/glimmer.py` | A10G | `serve_draft` |

## Seamless voice

```sh
pip install modal
SEAMLESS_APP_NAME=vale-seamless-<something-private> modal deploy modal/seamless.py
```

Modal prints an `https` URL. Check it talks, then keep the URL private:

```sh
curl -o warm.wav "https://<your-app>-web-speak.us-east.modal.run?speaker=17&text=Ready"
```

```sh
SEAMLESS_URL=https://<your-app>-web-speak.us-east.modal.run
```

Empty `SEAMLESS_URL` keeps the engine off. Warm synthesis takes about
a second; a cold container takes about a minute and the browser voice
covers every line until it answers.

## Glimmer briefs

```sh
modal secret create glimmer-auth GLIMMER_API_KEY=<token>
modal deploy modal/glimmer.py
modal run modal/glimmer.py::download_weights
```

The last command fetches the weights once into a Modal Volume; reruns
are a no-op. Use the `serve_draft` URL the deploy prints:

```sh
GLIMMER_URL=https://<your-app>-serve-draft.us-east.modal.run
export GLIMMER_TOKEN=<same-token-as-the-secret>
```

The token never lives in the repo. Without URL and token the cards
still open, with a sentence saying no private model is set up.

## Approximate cost

Rates at [modal.com/pricing](https://modal.com/pricing): T4 about
$0.59/h, A10 about $1.10/h, per second, $0 while scaled to zero.

| Call | Observed | Cost |
| --- | --- | --- |
| Warm Seamless synthesis | ~1 s on T4 | ~$0.0002 |
| Warm Glimmer brief | ~6 s on A10G | ~$0.002 |
| Cold start, either app | minutes, once per scale-from-zero | ~$0.01–0.30 |

Image builds and weight downloads bill CPU seconds only. The $110
hackathon budget never came close: a full demo day stays under $1.
