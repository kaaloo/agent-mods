# @kaaloo/kimi-platform

Letta Code provider mod for Kimi models via the [Moonshot AI Platform API](https://platform.kimi.ai).

## What it does

Registers a local provider (`kimi-platform`) that connects to `api.moonshot.ai/v1` and dynamically discovers available Kimi models (`kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`, etc.) from the `/v1/models` endpoint.

## Installation

```bash
cd packages/kimi-platform
npm install
letta install .
```

Then `/reload` in Letta Code, `/connect` and select "Kimi Platform", and enter your Moonshot API key from the [Kimi Platform Console](https://platform.kimi.ai/console/api-keys).

## Models

Models are discovered dynamically at connect time. After connecting, use `/model kimi-platform/kimi-k3` (or any other discovered model) to switch.

Requires a Kimi Platform API key (starts with `sk-`). Not compatible with Kimi Code CLI keys.
