"""Vale demo voice: SeamlessM4T v2 text-to-speech on a T4.

Deploy with your own Modal account:

    pip install modal
    modal secret create seamless-auth SEAMLESS_API_KEY=<a-long-random-token>
    SEAMLESS_APP_NAME=vale-seamless-<something-private> modal deploy modal/seamless.py
    SEAMLESS_URL=<the https URL Modal prints> SEAMLESS_TOKEN=<same-token> npm run dev

The URL and token live only in the local .env (gitignored) or the shell env, never in this repo.
The endpoint requires the token, like the Glimmer one.
"""

import io
import os
import time
import wave

import modal

try:
    # Real import inside the image. A plain deploy carries only modal,
    # so the name must still exist here for the endpoint annotation.
    from fastapi import Request
except ImportError:  # pragma: no cover - local deploy without fastapi
    Request = None  # type: ignore[assignment]

MODEL_ID = "facebook/seamless-m4t-v2-large"
GPU = "T4"
SAMPLE_RATE = 16_000
MAX_CHARS = 500
MAX_SPEAKER = 199

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "accelerate",
    "fastapi",
    "sentencepiece",
    "tiktoken",
    "torch",
    "transformers>=4.44,<5",
)

app = modal.App(os.environ.get("SEAMLESS_APP_NAME", "vale-seamless-tts-dev"))

auth = modal.Secret.from_name("seamless-auth")


def _authorized(authorization: str | None) -> bool:
    import hmac

    expected = os.environ.get("SEAMLESS_API_KEY", "")
    if not expected or not authorization:
        return False
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer" or not presented:
        return False
    return hmac.compare_digest(presented, expected)

volume = modal.Volume.from_name("vale-seamless-cache", create_if_missing=True)
HF_CACHE = "/root/.cache/huggingface"


@app.cls(
    image=image,
    gpu=GPU,
    timeout=600,
    volumes={HF_CACHE: volume},
)
class Speaker:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoProcessor, SeamlessM4Tv2ForTextToSpeech

        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = AutoProcessor.from_pretrained(MODEL_ID)
        self.model = SeamlessM4Tv2ForTextToSpeech.from_pretrained(MODEL_ID).to(
            self.device
        )

    @modal.method()
    def speak(self, text: str, speaker: int) -> tuple[bytes, float]:
        import torch

        started = time.monotonic()
        inputs = self.processor(
            text=text[:MAX_CHARS], src_lang="eng", return_tensors="pt"
        ).to(self.device)
        with torch.no_grad():
            waveform = (
                self.model.generate(
                    **inputs,
                    tgt_lang="eng",
                    speaker_id=min(MAX_SPEAKER, max(0, speaker)),
                )[0]
                .cpu()
                .numpy()
                .squeeze()
            )
        synthesis_seconds = time.monotonic() - started
        pcm = (waveform * 32767).astype("<i2").tobytes()
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm)
        return buffer.getvalue(), synthesis_seconds


@app.function(image=image, timeout=600, secrets=[auth])
@modal.fastapi_endpoint(method="GET")
def web_speak(request: Request, speaker: int = 17, text: str = ""):
    from fastapi import Response

    if not _authorized(request.headers.get("authorization")):
        return Response(
            content='{"error":"Missing or invalid token."}',
            media_type="application/json",
            status_code=401,
        )
    if text.strip() == "":
        return Response(
            content='{"error":"Missing text."}',
            media_type="application/json",
            status_code=400,
        )
    audio, synthesis_seconds = Speaker().speak.remote(text, speaker)
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"X-Synthesis-Seconds": f"{synthesis_seconds:.2f}"},
    )
