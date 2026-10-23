# Ensaios manuais da integração nativa

`npm test` usa clientes simulados. Os scripts desta pasta são ensaios locais adicionais e não são executados pela suite. `native-live.mjs` usa autenticação ChatGPT do Codex original e pode executar um pedido real inicial; `tui-final.py` executa outro pedido, salvo em modo de histórico. Não apontar os scripts para dados de produção.

1. `node validation/native-live.mjs`: cria dados em `/tmp/hydraq-native-live-*`, servidor em porta aleatória e uma sessão de ensaio. Mantém o processo aberto. Para reutilizar o ensaio, indica `NATIVE_TEST_DIR`.
2. `python3 validation/tui-final.py`: exige um turno novo, uma resposta final visível e ausência de reconexão. Requer `pexpect`. `NATIVE_HISTORY_ONLY=1` verifica apenas o histórico, sem enviar um pedido. `NATIVE_PROMPT` e `NATIVE_EXPECTED` permitem ensaiar uma chamada MCP.
3. `node validation/ui-check.mjs`: verifica os temas/larguras e executa a passagem de volta à HYDRAQ com um pedido real. `NATIVE_VISUAL_ONLY=1` limita-se aos controlos visuais. Usa o Playwright incluído no runtime local Codex e `/usr/bin/google-chrome`; adapta os caminhos noutra máquina.
4. Depois de terminar o servidor de ensaio: `node validation/import-restart.mjs` associa a mesma thread num estado isolado, reabre-o e compara contagens/IDs, sem inferência.

`desktop-check.mjs` é uma investigação parcial com perfil desktop isolado. Abrir a janela não confirma autenticação ou execução completas; a integração desktop continua desativada.
