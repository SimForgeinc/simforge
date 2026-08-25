"""simforge_alpamayo: quantized local Alpamayo 1.5 inference service.

Vendored upstream inference code (NVlabs/alpamayo1.5) is resolved from
``vendor/alpamayo1.5/src`` relative to the adapter root when not already
importable.
"""

import sys
from pathlib import Path

ADAPTER_ROOT = Path(__file__).resolve().parents[2]
_VENDOR_SRC = ADAPTER_ROOT / "vendor" / "alpamayo1.5" / "src"

try:  # pragma: no cover - trivial import plumbing
    import alpamayo1_5  # noqa: F401
except ModuleNotFoundError:  # pragma: no cover
    if _VENDOR_SRC.is_dir():
        sys.path.insert(0, str(_VENDOR_SRC))
    # else: tolerated — bridge.py/protocol.py are usable without the vendored
    # inference code (and without torch); engine.py calls require_vendored()
    # before its lazy `alpamayo1_5` imports for the actionable error.


def require_vendored() -> None:
    """Fail with setup guidance when the vendored inference code is absent."""
    try:
        import alpamayo1_5  # noqa: F401
    except ModuleNotFoundError:
        raise ModuleNotFoundError(
            f"alpamayo1_5 not importable and vendor dir missing: {_VENDOR_SRC}. "
            "Run scripts/setup.sh first."
        ) from None

PINS = {
    "model_repo": "nvidia/Alpamayo-1.5-10B",
    "model_revision": "7aba8293c09993f2e125c6819df05d7fa3e873ea",
    "cosmos_repo": "nvidia/Cosmos-Reason2-8B",
    "cosmos_revision": "a9fae2cf89dc64db96b12860417f0eb403013bb9",
    "processor_repo": "Qwen/Qwen3-VL-2B-Instruct",
    "processor_revision": "89644892e4d85e24eaac8bacfd4f463576704203",
    "inference_code_commit": "7a8f1c781a826f09be53e1e211f26e947ec18019",
}
