# @kaaloo/kimi-platform

Letta Code provider mod for Kimi models via the [Kimi Code API](https://api.kimi.com/coding).

## What it does

Registers a local provider (`lc-kimi-code`) that connects to `api.kimi.com/coding` and dynamically discovers available Kimi models (`k3`, `kimi-for-coding`, `kimi-for-coding-highspeed`) from the `/v1/models` endpoint.

## Installation

```bash
cd packages/kimi-platform
npm install
letta install .
```

Then `/reload` in Letta Code, `/connect` and select "Kimi Code", and enter your Kimi API key from the [Kimi Platform Console](https://platform.kimi.ai/console/api-keys).

## Models

Models are discovered dynamically at connect time. After connecting, use `/model lc-kimi-code/k3` (or any other discovered model) to switch.

Requires a Kimi API key (starts with `sk-kimi-`). Compatible with Kimi Coding plan keys.
