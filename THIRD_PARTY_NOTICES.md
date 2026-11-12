# Third-party notices

Deskhand itself is released under the [PolyForm Noncommercial License 1.0.0](LICENSE).

The app bundles and uses the components below. Each one stays under its own
license, and nothing in the Deskhand license overrides those terms.

Full license texts ship inside the app:
`Deskhand.app/Contents/Resources/` (`whisper-licenses/`, `transcribe-licenses/`,
`speech/GigaAM-LICENSE.txt`).

## Speech recognition

| Component | Source | License |
| --- | --- | --- |
| whisper.cpp v1.7.4 (`whisper-cli`) | https://github.com/ggml-org/whisper.cpp | MIT |
| transcribe.cpp v0.4.1 (`transcribe-cli`) | https://github.com/handy-computer/transcribe.cpp | MIT |
| ggml | https://github.com/ggml-org/ggml | MIT |
| miniz | https://github.com/richgel999/miniz | MIT |
| Silero VAD | https://github.com/snakers4/silero-vad | MIT |
| GigaAM v3 E2E-RNNT Q4_K_M weights | https://huggingface.co/handy-computer/gigaam-v3-e2e-rnnt-gguf | MIT, © 2024 GigaChat Team |

The GigaAM weights come from `ai-sage/GigaAM-v3`, converted to GGUF and
quantized; they were not retrained. Whisper models (`ggml-*.bin`) are not
bundled: the user points the app at their own file.

## Speech synthesis

| Component | Source | License |
| --- | --- | --- |
| Silero TTS V5.6 RU weights (downloaded on demand) | https://github.com/snakers4/silero-models | CC BY-NC-SA 4.0, © Silero Team |
| `silero-onnx-tts` runtime (installed on demand) | https://github.com/some1-in-here/silero-tts-onnx | CC BY-NC-SA 4.0 |
| ONNX Runtime (installed with the Silero runtime) | https://github.com/microsoft/onnxruntime | MIT |

### Silero V5.6 RU (CC BY-NC-SA 4.0)

The Silero engine is optional and is not part of the app bundle. When the user
presses “Скачать модель”, Deskhand installs
[`silero-onnx-tts`](https://github.com/some1-in-here/silero-tts-onnx) into a local
Python virtual environment and downloads the ONNX weights from its pinned
release. Both are derivative works of the Silero TTS V5 family and stay under
CC BY-NC-SA 4.0. They are offered for non-commercial use only; a commercial
distribution needs a different engine or a separate license from the Silero
Team.

## Application runtime

| Component | Source | License |
| --- | --- | --- |
| Electron 33.2.0 | https://github.com/electron/electron | MIT |
| React 18, React DOM 18 | https://github.com/facebook/react | MIT |
| electron-store 8.2.0 | https://github.com/sindresorhus/electron-store | MIT |

macOS system frameworks (AppKit, ScreenCaptureKit, AVFoundation, Speech, Metal,
Accessibility) are used under Apple's SDK agreement and are not redistributed.

## Build-only tooling

These run on the developer machine and are not part of a shipped build:
electron-vite, Vite, TypeScript (Apache-2.0), electron-builder, ESLint, Vitest,
`@vitejs/plugin-react`. Their licenses are listed in `package-lock.json` and in
each package's own `LICENSE` file under `node_modules/`.

## Model providers

Deskhand talks to OpenAI, OpenRouter or Anthropic APIs with the user's own key.
No provider SDK or model weight is bundled; the terms are the provider's own,
and requests carry OpenRouter's attribution headers where they ask for them.
