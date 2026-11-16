# pi-answer-now

End a reasoning model's thinking block while it writes.

Some reasoning models think for a long time before they answer. Basalt offers
`POST /v1/answer_now` to tell one running reply to close its thinking section
and start writing the answer. This extension adds two ways to call it:

- `/answer` in the chat.
- A keyboard shortcut, `alt+a` by default.

The extension changes nothing about the requests pi already sends. It reads the
request id from the response headers, and posts that id back on the side.

## Install

```bash
pi install npm:pi-answer-now   # or: pi install git:github.com/torhve/pi-answer-now
```

Restart pi, or run `/reload`.

## Use

Press the key while the model is thinking. The model closes its thinking block
and writes the answer. pi shows one line in the chat with the result.

Works on reasoning models only. See [Errors](#errors) for what each answer means.

## Settings

Add this to `~/.pi/agent/settings.json` to change the key:

```json
{
  "pi-answer-now": {
    "keybinding": "ctrl+alt+a"
  }
}
```

Run `/reload` after editing. Omit `pi-answer-now` to keep the default `alt+a`.

Pi writes user keybindings in `~/.pi/agent/keybindings.json`. That file lists
named actions, and an extension is not one of them, so it cannot rebind this
one. The setting above is the supported way.

Key form is `modifier+key`. Modifiers are `ctrl`, `shift`, `alt`, and `super`.
`pi` rejects an unusable form on startup and tells you which key it used
instead.

## How it finds the server

The extension takes the address from the model pi has in the session. Nothing
to configure.

| Setup | What the extension does |
| --- | --- |
| Model points at basalt directly | Calls `<base>/v1/answer_now`. |
| Model runs behind [llama-swap](https://github.com/mostlygeek/llama-swap) | llama-swap keeps a fixed route table, so the first call gets a 404. The extension then calls `<mount>/upstream/<model>/v1/answer_now`, which llama-swap forwards to the engine. It signs that call with the credentials pi already holds for the provider. |
| Cloud provider, or llama.cpp | No answer-now feature. One readable line in the chat. |

### Capability probe

On startup and on a model change, the extension reads one URL:

```text
GET <origin>/props?model=<model>&autoload=false
```

Basalt answers with `basalt.capabilities`, and `answer_now` appears in that
list. llama.cpp and llama-swap do not report it. The `autoload=false` part
matters: llama-swap then refuses instead of loading a model to answer a probe.

The result is cached per engine and model, and is used only to write a clearer
error line. The extension never uses it to skip the call. If
[pi-llama-swap](https://github.com/torhve/pi-llama-swap) already recorded
`answerNow` for the model in `~/.pi/agent/pi-llama-swap.json`, the extension
reads that value and skips the probe.

## Errors

| Line | Meaning |
| --- | --- |
| `Answer now: closed the thinking of <id> (was thinking).` | Worked. The id names the request that was interrupted. |
| `No request id yet for this model …` | The request has not reached the engine yet, usually because llama-swap is loading the model or the engine is reading a long prompt. Press again once the model starts. |
| `More than one request for <model> streams at once …` | pi has two requests to that model running. The extension will not guess which one to stop. |
| `The model is already writing its answer.` | Too late. The thinking was already closed. |
| `That reply has already finished.` | Too late. |
| `This model is running with thinking off …` | There was no thinking block to close. |
| `The engine no longer knows that request.` | The turn moved on. Press again during the new request. |
| `<engine> does not offer answer now.` | The probe read this engine's props, and answer now is not there. |
| `<engine> has no /v1/answer_now route …` | The server answered a bare 404. It is not basalt, or it is older than the feature. |
| `<engine> answered 404 on /v1/answer_now and on /upstream/<model>/v1/answer_now …` | A server in front of the engine strips both paths. Answer now cannot reach the engine. |
| `<engine> refused this call as unauthenticated (401).` | The server wants a key the extension does not have. |
| `Could not reach <engine>: …` | The server was unreachable or did not answer within two seconds. |

## Requirements

- pi 1.5.2 or newer. Pi 1.5.2 is the version this package is tested against.
- An engine that serves `/v1/answer_now`. [Basalt](https://github.com/jesdga95/basalt)
  0.3.3 and newer have it.
- A reasoning model with thinking on.

## Known limits

- **It interrupts the request that streams right now.** The engine writes its
  request id into every chunk of the reply, and the extension uses that id. If
  more than one request for the model streams at once, the extension refuses
  instead of guessing. The reply line names the id it used.
- **The server must pass the answer-now path through.** llama-swap reaches the
  engine for `/v1/answer_now` only through
  `/upstream/<model>/v1/answer_now`. A proxy that strips `/upstream` blocks the
  feature, and the extension says so instead of guessing.
- **Model names that hold a slash are handled by llama-swap's route.**
  llama-swap matches the model name inside the path. No live basalt model with a
  slash in its name was tested.
## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # biome check
```

Test against pi with only this package loaded:

```bash
pi -ne -e . --no-session
# then press alt+a, or type /answer
```

## License

MIT
