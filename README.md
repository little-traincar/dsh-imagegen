[English](README.md) | [简体中文](README.zh.md)
# dsh-imagegen---DSH RAW Image Plugin

Register the 'generate_image' tool for DeepSeek Harness agent: doubao Seedream 5.0 Pro / qwen-image-3.

# setup

```powershell
# npm 
dsh plugin --profile <name> add @little-traincar/dsh-imagegen

# Github
dsh plugin --profile <name> add github:little-traincar/dsh-imagegen#v0.1.1

# tarball
dsh plugin --profile <name> add ./dsh-imagegen-0.1.0.tgz
```

GitHub installation will be intercepted by pnpm for the first-time build authorization: add the package key to the profile's `pnpm-workspace.yaml` as prompted by `dsh`.

```yaml
allowBuilds:
  '@little-traincar/dsh-imagegen': true
```
(Source code checkout users can also: ` pnpm dsh web -- patch<repository>/imagegen/codes. yml `)

## delete
```
# pnpm
dsh plugin --profile <name> remove @little-traincar/dsh-imagegen
```

## use
1.Restart dsh ->Settings ->Imagegen ->Fill in Bean Pack/QWEN Key ->Save (with immediate effect; you can also use the environment variables' ARK_API_KEY '/' DASHSCOPE.API_KEY ').

2.In the conversation, it was mentioned that there is a need.

> for example: Draw a summer coffee shop promotion poster: retro magazine collage style, cream yellow+coffee brown, vertical version; Text: Main title "Summer Ice Cafe Festival" sub title "Half price for the second cup of the entire event";

The image is embedded and displayed in the conversation, and saved to 'outdir' (default '<startup directory>/generated images', can be changed in settings or patches).

**Map generation * *: paste the map into the session (or give the local absolute path/URL) and say "change this map to China-Chic style/change the background" - the agent will redraw based on the reference map through the 'image' parameter.

## Configuration (Priority: GUI Settings>cordis. catch. yml>Environment Variables)

| item | default | explanation |
|---|---|---|
| `apiKeys.*` | NULL | doubao / qwen key;environment variable `ARK_API_KEY` / `DASHSCOPE_API_KEY` |
| `baseUrls.*` | official | Can point to any OpenAI style `/images/generations` Compatible gateway |
| `models.*` | snapshot ID | Doubao alias will be 404, do not change it back `doubao-seedream-5-0-pro` |
| `outDir` |  Under the startup directory`generated-images` | Disk directory (absolute path) |
| `count` / `aspect` / `attachToConversation` / `requestTimeoutMs` | 2 / 2:3 / true / 300000 | picture habit |

## other
The dependent version is matched with the target DSH version; If the installation report says' version does not exist ', align the' package. json 'dependent version to your DSH version.

If you encounter the inability to input APIs, please check your DSH version. This plugin is developed based on 0.1.3-alpha. 2.

This project was completed with AI assisted development (Vibe coding) and has passed local smoke testing and real API call verification (real machine image output, watermark closure, attachment storage, and session embedding have all been tested and passed); If any abnormalities are found, please feel free to raise an issue or PR.