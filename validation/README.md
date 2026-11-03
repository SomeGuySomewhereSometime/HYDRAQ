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


## Catálogos automáticos e quotas

`node validation/provider-status-ui.mjs [pasta-de-provas]` verifica com clientes simulados a chegada de um modelo novo (Terra), preservação de seleção e raciocínio, quotas por modelo/grupo, cores personalizadas, avisos de limites baixos, Dual/Hydra, falhas, metadados e apresentação nas três aparências e em ecrã estreito. Não usa o estado de produção.

`node validation/provider-catalogs-live.mjs [pasta-de-provas]` consulta apenas catálogos e quotas nos três clientes originais autenticados, com estado HYDRAQ temporário. Não cria turnos de modelo. Confirma o catálogo Codex com Terra e `ultra`, o `get_usage` do Claude e o `/usage` JSON do agy. Não executar como teste automático: requer os clientes e as sessões reais disponíveis.

### Ditado por microfone

`node validation/dictation-ui.mjs` usa Chrome, MediaRecorder e microfone sintético, com clientes isolados e transcrição simulada; não consulta a Groq nem usa conversas reais. Verifica rascunho, envio bloqueado, cancelamentos, troca de conversa, recusa de permissão, quota, aparências e ecrã de 390 px. Capturas em `/tmp/hydraq-dictation-ui/`. Testes do serviço e HTTP: `node --test test/dictation.test.mjs`.

### Mascote e delegações

`node validation/companion-ui.mjs` usa clientes, histórico e Gemini simulados num servidor temporário. Verifica pedido/resposta na conversa de origem, identificação da mascote, isolamento do diálogo informal, paginação, rascunhos, scroll, ampliação, móvel e transcrições em direto com microfone virtual. Não usa chaves reais nem conversas do utilizador. Capturas em `output/companion-desktop.png` e `output/companion-mobile.png`. O Chromium instalado pode ser escolhido com `HYDRAQ_TEST_CHROMIUM`. Testes do serviço e da proveniência: `node --test test/companion.test.mjs`.

`node validation/mascot-character-ui.mjs` verifica o modelo 3D, os clips Idle/Walk/Listen/Talk, movimentos independentes de pescoços/cabeças/olhos, marcha e apoio dos pés, estados e cores dos cinco clientes, clique e teclado, arrastar e posição após recarregar, painel na margem esquerda, vista móvel, janela baixa, movimento reduzido e alternativa vetorial quando o WebGL2 está indisponível. Usa clientes e projeto temporários, sem inferência real; permite escolher o Chromium com `HYDRAQ_TEST_CHROMIUM`.

### Pastas e repetição de pedidos Hydra

`node validation/folders-ui.mjs` verifica o seletor com navegação e criação atrasadas, criação de projeto por caminho escrito, conversas em pastas distintas e recuperação de uma tarefa Hydra cuja primeira resposta HTTP se perde depois de o servidor a aceitar. Usa clientes e dados temporários; não envia pedidos a modelos reais. `HYDRAQ_TEST_CHROMIUM` permite escolher o Chromium. `node --test test/claudex-ui.test.mjs test/folders.test.mjs test/projects.test.mjs` inclui a recuperação pelo separador Hydra e pela conversa, com a mesma pasta/identificador e sem duplicação.

## Multi (2 a 4 clientes)

`node validation/multi-ui.mjs [pasta-de-saida]` usa apenas clientes simulados e dados temporários. Verifica configuração, envios a todos e subconjuntos, entrada/saída, síntese, passagem ao Hydra, criação de conversa e recuperação sem duplicação após respostas HTTP perdidas. Inspeciona Atelier e Mono a 1440, 1024 e 390 px, com capturas na pasta de saída (por omissão `output/multi-validation`). Os testes de protocolo, persistência e recuperação estão em `test/multi.test.mjs`; o regresso de um Multi de quatro pelo Hydra está em `test/claudex-inplace.test.mjs`.

`node validation/multi-live.mjs --run [pasta-de-evidencia]` usa os quatro clientes reais em sessões novas e pasta temporária, com prompts sintéticos curtos de leitura. Escolhe modelos nos catálogos ligados e verifica ronda a quatro, subconjunto, contexto, síntese e saída/reentrada. Este ensaio consome quota das contas; não usa conversas pessoais da aplicação.

## Planos Cursor e texto integral

- `node validation/cursor-output-ui.mjs [saída]`: Cursor simulado, plano de 130 mil caracteres, leitura/download/autenticação, recarregamento, móvel e aprovação pendente sem execução.
- `node validation/cursor-output-live.mjs --run [saída]`: Cursor/Grok e Codex reais em pasta/sessões novas, mais um participante sintético com 140 mil caracteres. Verifica CreatePlan e o ficheiro integral, passagem para Normal e síntese real acima dos antigos limites. Usa quota das contas; o plano de execução do ensaio é rejeitado, nunca aprovado automaticamente.
- `test/cursor-plan-files.test.mjs` e `test/plan-document-http.test.mjs`: armazenamento privado, autorização e pedido autenticado acima de 650 KB. `test/handoff.test.mjs` cobre `plan.steps`, respostas completas e compatibilidade com revisões explícitas antigas.


## Hydra com dois ou três participantes

`node validation/hydra-workflow-ui.mjs` verifica seleção do trio/principal, fases, testes, histórico e móvel com clientes simulados. `hydra-inplace-ui.mjs` cobre o regresso ao Multi com histórico e sessões preservados. `node validation/hydra-clarification-ui.mjs [pasta]` cobre esclarecimento durante a implementação, replaneamento e tarefa terminada, também com clientes simulados.

`node validation/hydra-question-live.mjs --run [pasta]` usa subscrições reais: o principal, o Claude, faz uma pergunta nativa já na implementação, e a resposta, dada pelo coordenador, acrescenta um requisito. O ensaio regista se o modelo pediu um novo plano ou incorporou o requisito, e verifica a conclusão.

`node validation/hydra-selfcopy-live.mjs --run [pasta]` usa subscrições reais e uma cópia da própria HYDRAQ como projeto, na cópia privada. A tarefa corrige uma falha real do filtro de comandos, e o resultado é verificado com os testes do próprio projeto, corridos fora da tarefa. `HYDRA_PAUSE_IN` em `hydra-workflow-live.mjs` aceita várias fases separadas por vírgulas.

`node validation/hydra-history-ui.mjs` verifica, com clientes simulados, a saída completa de um teste longo no cartão e **Apagar tarefa**: confirmação, ficheiros removidos, resposta publicada na conversa e pedidos internos escondidos.

`node validation/hydra-participants-ui.mjs` verifica, com clientes simulados e num browser real, a pausa da vigilância a dizer quem está preso, a confirmação e o efeito de **Retirar**, e os dois restantes a continuarem do mesmo voto.

`HYDRA_OBJECTOR=<cliente>` em `validation/hydra-workflow-live.mjs` diz a esse participante, no próprio pedido, para objetar uma vez ao plano; o ensaio verifica com modelos reais a resposta do principal, a decisão por maioria, o registo na conclusão e a leitura de `read_changes` por todos.

`node validation/hydra-workspace-ui.mjs /tmp/hydra-workspace-ui-provas` verifica a opção **Cópia privada** no painel Modo e no separador Hydra, compatibilidade com servidores antigos, recarregamento, trio, testes e aplicação só depois dos votos finais. Usa apenas clientes simulados, projetos temporários, Git/bubblewrap reais e servidor numa porta aleatória. `hydra-workspace-scenarios.mjs` produz os estados reais de aplicação interrompida, edição que impede desfazer, conflito, confirmação Git e exceção antes de escrever; os cliques na página retomam ou desfazem pelo coordenador. Também aplica e apaga uma cópia depois da devolução da conversa, confirma que cancelar conserva a cópia e que um projeto entretanto alterado é recusado. Não encena estes estados através de respostas falsas. Injeta ainda uma falha HTTP para testar o histórico e guarda capturas de três temas e ecrã de 390 px. A saída tem de ficar em `/tmp`. Os testes de envio e repetição sem duplicar tarefas estão em `test/claudex-ui.test.mjs`.

`node validation/hydra-permissions-live.mjs --run [pasta]` usa subscrições reais, sessões novas e um projeto sintético, e confirma no disco o que cada principal consegue fazer: escrever no projeto, fora dele, em `.git`, por uma ligação simbólica, usar a rede, `systemd-run`, `npm test`, `pytest` e `git status`. Cria e apaga uma pasta temporária em `~/.cache`, e atualiza o hook global do agy se a versão instalada for outra. `HYDRA_ROLES` escolhe os clientes; as predefinições são GPT-6.1 Sol, Sonnet e Gemini 3.8 Flash.

`node validation/hydra-reviewer-live.mjs --run [pasta]` faz um turno real do Gemini 3.8 Flash como revisor, num repositório temporário em `~/.cache` cujo `core.fsmonitor` escreve um marcador: confirma pelo disco que um `git status` funciona e que o programa não escreve fora do isolamento. Atualiza o hook global do agy se a versão instalada for outra.

`node validation/hydra-resume-live.mjs --run [pasta]` usa subscrições reais, sessões novas e um projeto sintético: fecha e reabre o servidor com o principal a escrever e pausa e retoma na revisão e na conclusão, confirmando as mesmas sessões, uma só ronda e a conversa devolvida. `HYDRA_ROLES` e `HYDRA_AUTHOR` escolhem os participantes; predefinição Sonnet + Flash.

`node validation/hydra-replan-live.mjs --run [pasta]` usa subscrições reais, sessões novas e um projeto sintético. O ensaio introduz o esclarecimento e o `request_replan` durante a escrita; não prova que um modelo os use por iniciativa própria. Exige que todos continuem a usar as ferramentas da tarefa depois do replaneamento e conclui a tarefa, salvo `HYDRA_STOP_AFTER_POSITIONS=1`. Predefinições: GPT-6.1 Sol, Sonnet e Gemini 3.8 Flash, com o último dos `HYDRA_ROLES` como principal se `HYDRA_AUTHOR` não for indicado.

`node validation/hydra-workflow-live.mjs --run output/hydra-live` usa subscrições reais, sessões novas e um projeto sintético. `HYDRA_WORKSPACE=copy` faz a tarefa trabalhar numa cópia privada e confirma que o projeto só muda depois de aprovado e que cada sessão continua depois de a cópia desaparecer; `HYDRA_INPLACE=1` começa numa conversa já existente, `HYDRA_PAUSE_IN=<fase>` faz uma pausa e retoma reais nessa fase e `HYDRA_USER_EDIT=1` edita outro ficheiro mesmo antes da conclusão. `HYDRA_PROJECT=realista` acrescenta Git, dependências ignoradas, caches de Python, um `.env` fictício e pede validação com `npm test`, `pytest` e `git diff`. Predefinições: GPT-6.1 Sol, Opus 5.5 (confirmado pelo catálogo) e Argon. `HYDRA_AUTHOR` escolhe quem implementa, `HYDRA_ROLES` escolhe dois/três clientes, `HYDRA_SCENARIO=plan` confirma ausência de escrita e `HYDRA_INJECT_FAILURE=1` injeta um erro controlado só na fixture após implementar, exigindo deteção/correção e testes novos. Os ficheiros JSON de evidência distinguem modelo real, projeto de ensaio e erro injetado.
