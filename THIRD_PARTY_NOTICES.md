# Third-party notices

Deskhand itself is released under the [MIT License](LICENSE).

The app bundles and uses the components below. Each one stays under its own
license, and nothing in the Deskhand license overrides those terms.

Full license texts ship inside the app:
`Deskhand.app/Contents/Resources/` (`piper/licenses/`, `whisper-licenses/`,
`transcribe-licenses/`, `speech/GigaAM-LICENSE.txt`).

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
| Piper | https://github.com/rhasspy/piper | MIT, © 2022 Michael Hansen |
| piper-phonemize | https://github.com/rhasspy/piper-phonemize | MIT |
| ONNX Runtime 1.14.1 | https://github.com/microsoft/onnxruntime | MIT |
| eSpeak NG 1.52.0 (`libespeak-ng`, `espeak-ng-data`) | https://github.com/espeak-ng/espeak-ng | GPL-3.0 |
| Voice `ru_RU-ruslan-medium` | https://huggingface.co/rhasspy/piper-voices (`ru/ru_RU/ruslan/medium`) | Training dataset: CC BY-NC-SA 4.0 |

### eSpeak NG (GPL-3.0)

eSpeak NG ships as a separate dylib plus its data directory, unmodified, taken
from Piper's macOS release archives. The full license text is in
`Resources/piper/licenses/eSpeak-NG.txt`. When distributing the binaries, make
the corresponding source for the exact bundled build available as required by
[GPL-3.0 section 6](https://www.gnu.org/licenses/gpl-3.0.html#section6).

### Ruslan voice (CC BY-NC-SA 4.0)

The [voice model card](https://huggingface.co/rhasspy/piper-voices/blob/217ddc79818708b078d0d14a8fae9608b9d77141/ru/ru_RU/ruslan/medium/MODEL_CARD)
identifies the [Ruslan corpus](https://ruslan-corpus.github.io/) as the training
dataset and lists its license as CC BY-NC-SA 4.0. Deskhand includes this voice for
non-commercial use. Use a voice with commercially usable terms in a commercial
distribution.

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
