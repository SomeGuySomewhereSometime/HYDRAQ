# Codex original: terminal e HYDRAQ

A HYDRAQ continua a executar o cliente original `codex app-server` por stdio, com autenticação ChatGPT. O terminal original liga-se a um adaptador privado por socket Unix e usa a mesma thread. O servidor da HYDRAQ tem de continuar em execução; o browser/preview pode estar fechado.

Em **Configurações e detalhes → Codex original**, escolhe **Abrir no terminal** depois de concluir um primeiro pedido. Se a janela não abrir, expande o comando e executa-o no teu terminal. Fechar o terminal conserva o trabalho em curso. **Ver comando do terminal** permite voltar a ligar. Para escrever novamente na interface, aguarda a conclusão e escolhe **Continuar na HYDRAQ**. Aprovações e Parar continuam disponíveis na HYDRAQ.

Os pedidos admitidos no terminal percorrem `Providers.send`: memória atual, contexto das passagens, anexos, MCP do projeto e revisões automáticas continuam a ser preparados pela aplicação. O controlo de envio pertence a uma interface por grupo. Não há reenvio automático após entrega incerta. O histórico é recuperado por páginas e aplicado apenas depois de uma leitura completa, sem apagar eventos recebidos entretanto.

**Associar sessão Codex existente** procura apenas na pasta indicada e exige selecionar uma sessão. Fecha primeiro o cliente que detenha a escrita; o adaptador não força a sua libertação. A associação mantém o ID nativo. Texto, respostas, ações e metadados nativos são recuperados; imagens antigas de sessões externas não são automaticamente convertidas para anexos geridos pela HYDRAQ. Imagens enviadas pelo novo terminal passam pelo armazenamento normal da aplicação.

## Compatibilidade e limites

Validado em Linux, Codex CLI **0.159.0**. O adaptador suporta texto, imagens locais, seleção de modelo/raciocínio, orientação, interrupção e decisões individuais. Modos Plan/multiagente, novos chats/forks, execução direta de comandos fora do pedido, gestão de plugins/configuração e outras operações ainda não integradas são recusados explicitamente. Uma decisão não suportada mantém o pedido pendente e apresenta aviso; podes resolvê-lo na HYDRAQ. Não se promete paridade com todos os comandos do TUI.

A app desktop permanece indisponível. O ensaio com uma instância isolada abriu a interface, mas não validou o seu fluxo completo de autenticação, gestão e execução. Não há botão nem ligação à instalação ativa. Para usar uma sessão externa na HYDRAQ, usa a associação explícita depois de a fechar no cliente original.

## Revisão e provas de 2026-10-23

A revisão do checkpoint identificou e corrigiu:

- Desconexão real provocada pelo catálogo de plugins com aproximadamente 18 MB. O envio usa frames de 64 KiB e limite agregado de 64 MiB; a ligação lenta que ultrapassar o limite continua a ser fechada explicitamente.
- Imagens locais sem MIME no armazenamento e projeção do pedido que removia imagens. A leitura é limitada, rejeita symlinks/ficheiros especiais e preserva os elementos não textuais.
- Recuperação de histórico que publicava estado parcial antes de receber todas as páginas. A nova aplicação é atómica e rejeita um histórico que concorra com eventos novos.
- Propostas de memória que podiam iniciar inferência pela interface enquanto o terminal controlava o grupo.
- Modelo/raciocínio enviados dentro de `collaborationMode.settings` ignorados pelo adaptador. A precedência segue o schema experimental gerado pelo CLI instalado. A página inicial pedida pelo TUI também é devolvida.
- Decisões nativas não suportadas que ficavam sem explicação visível.

Verificações automáticas: **337 testes aprovados**, incluindo 13 específicos da integração. Cobrem exclusão de controlo, contexto atualizado, imagens, catálogo grande, reconexão/aprovações concorrentes, IDs repetidos, paginação falhada, eventos concorrentes, modelos, associação e revisões automáticas. Os clientes das regressões são simulados; a passagem para Claude nesse conjunto não representa implementação ou ensaio real novo de Claude.

Ensaios reais separados: resposta final visível no TUI sem reconexão; chamada MCP `get_project_memory` com resposta correta; volta à HYDRAQ pelo browser e novo pedido concluído; associação num estado isolado e novo arranque preservando **9 turnos, 20 mensagens e o mesmo ID**. Browser Grafite/Atelier a 1440/390 px, comando visível, envio bloqueado durante o controlo do terminal, seleção de sessão e libertação funcionais, sem overflow nem erros de página observados.

Provas locais: `.hydraq/native-terminal-2026-10-23/VALIDACAO.md`. Scripts manuais em `validation/`; `native-live.mjs` e `tui-final.py` podem executar pedidos reais e não fazem parte de `npm test`. Os testes não necessitam de abrir ou reiniciar a instalação desktop do utilizador.
