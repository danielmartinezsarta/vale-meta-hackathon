"""Serve Muse Glimmer on Modal with llama-server (CUDA).

The drafter endpoint (serve_draft, 1.7x decode) is the production one;
the plain serve endpoint stays for baseline.


App name: vale-glimmer
Weights: downloaded INSIDE Modal from meta-models/Muse-Glimmer-30B-GGUF
         into the Modal Volume "glimmer-weights". Nothing from the Mac.
Binary: prebuilt llama.cpp b12061 CUDA 12.8 (>= b10353, has muse-glimmer arch).
Flags per model card: --jinja, -ngl 99, n_ctx_slot checked in logs,
never stop on <|eom|>, reasoning_strength low + --reasoning-budget.
Endpoint: OpenAI-compatible, protected by --api-key (Modal secret
"glimmer-auth", env GLIMMER_API_KEY). Scales to zero when idle.
"""

import modal

APP_NAME = "vale-glimmer"
VOLUME_NAME = "glimmer-weights"
WEIGHTS_DIR = "/weights"
LLAMA_DIR = "/opt/llama"
LLAMA_BIN = f"{LLAMA_DIR}/llama-b12061/llama-server"
LLAMA_BUILD = "b12061"

TEXT_GGUF = "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf"
DRAFT_GGUF = "dflash-Muse-Glimmer-30B-Q4_K_M.gguf"
HF_REPO = "meta-models/Muse-Glimmer-30B-GGUF"

app = modal.App(APP_NAME)
vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.0-runtime-ubuntu24.04", add_python="3.11"
    )
    .apt_install("curl", "libgomp1")
    .run_commands(
        f"curl -sSL -o /tmp/llama.tar.gz "
        f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/"
        f"llama-{LLAMA_BUILD}-bin-ubuntu-cuda-12.8-x64.tar.gz",
        f"mkdir -p {LLAMA_DIR} && tar xzf /tmp/llama.tar.gz -C {LLAMA_DIR} "
        "&& rm /tmp/llama.tar.gz",
        f"find {LLAMA_DIR} -name llama-server -type f",
        f"{LLAMA_BIN} --version",
    )
    .pip_install("huggingface_hub", "hf_transfer")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)

auth = modal.Secret.from_name("glimmer-auth")

BASE_FLAGS = (
    f"-m {WEIGHTS_DIR}/{TEXT_GGUF} "
    "-a muse-glimmer-30B "
    "-ngl 99 -c 65536 -np 4 "
    "--host 0.0.0.0 --port 8080 "
    "--jinja "
    "--reasoning-budget 512 "
    "--chat-template-kwargs '{\"reasoning_strength\":\"low\"}' "
    "--temp 1.0 --top-p 0.95 --top-k 64 "
)
API_KEY_FLAG = '--api-key "$GLIMMER_API_KEY"'


@app.function(image=image, cpu=1, timeout=300)
def build_info():
    """CPU-only: proves which code revision is deployed."""
    return {"llama_bin": LLAMA_BIN, "base_flags": BASE_FLAGS}


@app.function(
    image=image,
    volumes={WEIGHTS_DIR: vol},
    cpu=4,
    timeout=4 * 3600,
)
def download_weights():
    """One-shot: fetch the two GGUFs into the Volume. Rerun is a no-op."""
    import os

    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=HF_REPO,
        local_dir=WEIGHTS_DIR,
        allow_patterns=[TEXT_GGUF, DRAFT_GGUF],
    )
    for name in (TEXT_GGUF, DRAFT_GGUF):
        path = os.path.join(WEIGHTS_DIR, name)
        print(f"{name}: {os.path.getsize(path)} bytes")
    vol.commit()


def _serve_cmd(with_draft: bool) -> list:
    draft = f"-md {WEIGHTS_DIR}/{DRAFT_GGUF} -ngld 99 " if with_draft else ""
    return [
        "bash",
        "-lc",
        f"exec {LLAMA_BIN} {BASE_FLAGS}{draft}{API_KEY_FLAG}",
    ]


@app.function(
    image=image,
    volumes={WEIGHTS_DIR: vol},
    gpu="A10G",
    secrets=[auth],
    timeout=3600,
    scaledown_window=60,
)
@modal.web_server(8080, startup_timeout=900)
def serve():
    """llama-server WITHOUT the drafter (baseline)."""
    import subprocess

    subprocess.Popen(_serve_cmd(with_draft=False))
    return


@app.function(
    image=image,
    volumes={WEIGHTS_DIR: vol},
    gpu="A10G",
    secrets=[auth],
    timeout=3600,
    scaledown_window=60,
)
@modal.web_server(8080, startup_timeout=900)
def serve_draft():
    """llama-server WITH the dflash drafter (speculative decoding)."""
    import subprocess

    subprocess.Popen(_serve_cmd(with_draft=True))
    return
