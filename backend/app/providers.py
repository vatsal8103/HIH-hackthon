"""Target model providers.

The deterministic simulator is the default and the only provider implemented. A real
model provider would be a class with the same three members, selected by
BAYORA_TARGET_PROVIDER and reading its API key from the environment of the process
that runs the target (the target agent in Docker), never from the frontend.
"""

import os

from app import target


class SimulatorProvider:
    id = "bayora-simulator/rules-v1"
    kind = "simulated"

    def respond(self, prompt: str) -> str:
        return target.model(prompt)


def get_provider() -> SimulatorProvider:
    name = os.environ.get("BAYORA_TARGET_PROVIDER", "simulator")
    if name != "simulator":
        raise RuntimeError(f"Target provider '{name}' is not implemented; only 'simulator' is available")
    return SimulatorProvider()
