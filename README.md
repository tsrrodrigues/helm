# Helm

Helm é um overlay para macOS (Electron) sempre visível (`always-on-top`) para monitorar sessões tmux com agentes de IA (Claude Code/Codex), destacando quem está **rodando** e quem está **aguardando ação**.

## Instalação

```bash
cd helm
./install.sh      # npm install
npm run service   # instala e inicia como serviço background (LaunchAgent)
```

## Como rodar

### Serviço background (recomendado)
```bash
npm run service       # instala LaunchAgent + inicia automaticamente no login
npm run service-stop  # para e remove o serviço
```

O serviço roda via macOS LaunchAgent (`com.helm.app`), com `RunAtLoad` e `KeepAlive`. Logs em `~/.helm/logs/`.

### Manual (terminal)
```bash
npm start             # daemon + Electron overlay
node daemon.js        # daemon standalone (sem Electron)
```

## Live reload

Ao rodar via `npm start` ou serviço, alterações em arquivos são detectadas automaticamente:

- `daemon.js` → daemon reinicia
- `main.js`, `preload.js` → Electron reinicia
- `renderer/` (html, css, js) → reload in-place (sem reiniciar Electron)

## Atalho global

- `⌘⇧Space` (`CommandOrControl+Shift+Space`)
- Abre o painel e seleciona a frente com `oldest waiting`.
- Pressione Enter para navegar direto ao pane.

## Detecção de estado

O daemon consulta tmux a cada 2 segundos:

- `tmux list-panes -a` para listar panes
- `tmux capture-pane -p -t <pane>` para últimas linhas visíveis

Detecção de agente: o comando do pane é verificado contra padrões (`claude`, `codex`, `node`, versão semver).

Regras:

- **running**: output contém spinners (`✻`, `◆`, `⠋`…) ou texto de atividade (`Thinking...`, `Reading...`, etc.), ou output mudou desde o último ciclo. Atividade sempre tem prioridade sobre prompts.
- **waiting** (com prompt): comando é agente, output estável por >= 3s, e última linha é prompt reconhecido (`>`, `❯`, `$`, `?`, `accept edits`, `How should`, etc.).
- **waiting** (fallback): comando é agente, output estável por >= 8s sem prompt reconhecido.
- **idle**: comando do pane é shell (`bash`, `zsh`, `fish`).
- panes com `vim`, `nvim`, `less`, `man` são ignorados.

## Navegação WezTerm

O mapeamento sessão → aba WezTerm usa cross-reference por TTY:

1. `tmux list-clients` → mapa TTY → sessão tmux
2. `wezterm cli list --format json` → mapa TTY → tab_id WezTerm
3. Cruzamento: sessão → TTY → tab_id

Ao clicar "ir →", Helm seleciona o pane no tmux e ativa a aba correta no WezTerm.

## Nomeação por IA

Para sessões novas, o daemon tenta sugerir nome curto via API da Anthropic usando:

- `ANTHROPIC_API_KEY` (env) ou `~/.config/anthropic/api_key`
- salva em `~/.helm/session-names.json`

Sem API key, usa fallback para o nome da sessão tmux.

## Debug

Endpoint HTTP para diagnóstico da detecção de estado:

```
curl http://127.0.0.1:7374/debug
```

Mostra: output raw de cada pane, resultado de `isWaitPrompt`, `hasRunIndicator`, detecção de agente.

## Estrutura

```
helm/
├── package.json
├── main.js              # Electron main process + renderer hot reload
├── preload.js           # context bridge
├── daemon.js            # tmux polling, status detection, WebSocket server
├── start-all.js         # orchestrator: daemon + Electron + file watchers
├── install.sh           # npm install wrapper
├── README.md
├── scripts/
│   ├── install-service.sh    # LaunchAgent setup (bootstrap)
│   └── uninstall-service.sh  # LaunchAgent teardown (bootout)
└── renderer/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Observações

- Se tmux não estiver ativo, o daemon publica `{ fronts: [] }`.
- Se `wezterm cli` falhar, o monitoramento continua; só o mapeamento de tab é pulado.
- A janela do Electron é transparente fora da pill/painel.
- O daemon requer `LANG=en_US.UTF-8` para parsear output do tmux corretamente (configurado no LaunchAgent plist e no `sysEnv` do daemon).
- Electron é lançado via `open -n Electron.app` para funcionar sob launchd (que não tem contexto GUI).
