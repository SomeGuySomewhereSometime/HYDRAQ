# Ensaios manuais da integração nativa

`npm test` usa clientes simulados. Os scripts desta pasta são ensaios locais adicionais e não são executados pela suite. `native-live.mjs` usa autenticação ChatGPT do Codex original e pode executar um pedido real inicial; `tui-final.py` executa outro pedido, salvo em modo de histórico. Não apontar os scripts para dados de produção.

1. `node validation/native-live.mjs`: cria dados em `/tmp/hydraq-native-live-*`, servidor em porta aleatória e uma sessão de ensaio. Mantém o processo aberto. Para reutilizar o ensaio, indica `NATIVE_TEST_DIR`.
2. `python3 validation/tui-final.py`: exige um turno novo, uma resposta final visível e ausência de reconexão. Requer `pexpect`. `NATIVE_HISTORY_ONLY=1` verifica apenas o histórico, sem enviar um pedido. `NATIVE_PROMPT` e `NATIVE_EXPECTED` permitem ensaiar uma chamada MCP.
3. `node validation/ui-check.mjs`: verifica os temas/larguras e executa a passagem de volta à HYDRAQ com um pedido real. `NATIVE_VISUAL_ONLY=1` limita-se aos controlos visuais. Usa o Playwright incluído no runtime local Codex e `/usr/bin/google-chrome`; adapta os caminhos noutra máquina.
4. Depois de terminar o servidor de ensaio: `node validation/import-restart.mjs` associa a mesma thread num estado isolado, reabre-o e compara contagens/IDs, sem inferência.

`desktop-check.mjs` é uma investigação parcial com perfil desktop isolado. Abrir a janela não confirma autenticação ou execução completas; a integração desktop continua desativada.

## Memória Claude e protocolo TUI sem inferência

`node validation/claude-terminal-memory-live.mjs` faz dois pedidos mínimos reais ao Claude Haiku pela subscrição. Usa configuração, histórico e estado HYDRAQ temporários; copia a credencial local para esse perfil sem a mostrar e elimina a cópia no fim. Valida `--resume -p` do CLI original, não uma janela TUI interativa, e guarda um `result.json` sem segredos. Não executar como teste automático.

`NATIVE_PROBE_DIR=/tmp/pasta-de-ensaio node validation/native-probe.mjs` inicia um App Server Codex com configuração temporária e thread efémera. Não copia autenticação. Os pedidos de inferência são substituídos por eventos de teste; outras operações desconhecidas são recusadas. Só leitura de metadados, confiança na própria pasta temporária e definições da thread são encaminhadas para o servidor original.

Com esse servidor aberto, executar separadamente `NATIVE_PROBE_DIR=/tmp/pasta-de-ensaio python3 validation/native-probe.py queue`, depois `model` e `external`. Requer `pexpect` e o TUI original instalado. Guarda métodos, texto do terminal e resultados por cenário. A fila e os turnos do executor são simulados; as teclas e os métodos emitidos pelo TUI são reais. Não prova execução com modelo, integração da fila no HYDRAQ nem compatibilidade com outras versões/configurações do CLI.

## Terminal Claude interativo

`python3 validation/claude-terminal-interactive.py full` abre o Claude Code interativo com o comando exato que a HYDRAQ mostra, contra uma HYDRAQ isolada (`claude-terminal-interactive.mjs`, só o cliente Claude, porta e dados temporários). Em modo normal: consulta sem pedido de autorização, HYDRAQ parada (mensagem de indisponibilidade), HYDRAQ reiniciada com outro marcador de memória (o mesmo terminal recupera), `/exit` e regresso com pedidos e consultas. `plan` faz uma consulta em Planear e regressa. Requer `pexpect`. Faz alguns pedidos Haiku reais pela subscrição, com uma cópia temporária da credencial Claude (recusa se o token expirar em menos de 30 minutos) apagada no fim; remove do ambiente a identidade de uma sessão Claude que esteja a executar o script, como faz a HYDRAQ. Não executar como teste automático. O Claude interativo pode atualizar-se sozinho durante o ensaio, como em qualquer utilização.

Com `PROBE_SETTINGS=hydraq`, `native-probe.mjs` responde a `thread/settings/update` como o adaptador de produção (resultado vazio e `thread/settings/updated` construído por `nativeThreadSettings`); o cenário `model` regista então o modelo escolhido, se aparece no TUI e se houve erro.

