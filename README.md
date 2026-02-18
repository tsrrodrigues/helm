# Helm

Helm é um overlay para macOS (Electron) sempre visível (`always-on-top`) para monitorar sessões tmux com agentes de IA (Claude Code/Codex), destacando quem está **rodando** e quem está **aguardando ação**.

## Instalação

```bash
cd ~/helm
./install.sh
```

## Como rodar

### Overlay
```bash
npm start
```

### Daemon standalone (sem Electron)
```bash
node daemon.js
```

### Iniciar daemon + overlay
```bash
node start-all.js
```

## Atalho global

- `⌘⇧Space` (`CommandOrControl+Shift+Space`)
- Abre o painel e seleciona a frente com `oldest waiting`.
- Pressione Enter para navegar direto ao pane.

## Detecção de estado

O daemon consulta tmux a cada 3 segundos:

- `tmux list-panes -a` para listar panes
- `tmux capture-pane -p -t <pane> -S -3` para últimas linhas

Regras:

- **running**: output contém padrões de atividade (`✻`, `◆`, `Thinking`, `Reading`, etc.) ou mudou desde o último ciclo.
- **waiting**: comando atual é `claude`/`codex`/`node`, output estável por >= 8s, e última linha parece prompt/espera (`>`, `❯`, `$`, `?`, `Awaiting`, `Done`, `✔`, `How should`).
- **idle**: comando do pane é shell (`bash`, `zsh`, `fish`).
- panes com `vim`, `nvim`, `less`, `man` são ignorados.

## Nomeação por IA

Para sessões novas, o daemon tenta sugerir nome curto via API da Anthropic usando:

- `ANTHROPIC_API_KEY` (env) ou `~/.config/anthropic/api_key`
- salva em `~/.helm/session-names.json`

Sem API key, usa fallback para o nome da sessão tmux.

## Estrutura

```
~/helm/
├── package.json
├── main.js
├── preload.js
├── daemon.js
├── start-all.js
├── install.sh
├── README.md
└── renderer/
    ├── index.html
    ├── styles.css
    └── app.js
```

## Observações

- Se tmux não estiver ativo, o daemon publica `{ fronts: [] }`.
- Se `wezterm cli` falhar, o monitoramento continua; só o mapeamento de tab é pulado.
- A janela do Electron é transparente fora da pill/painel.
