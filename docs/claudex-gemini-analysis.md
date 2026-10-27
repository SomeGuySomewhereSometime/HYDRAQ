# ClaudeX com Gemini — nota para revisão pelo Claude

2026-10-25. Guardado a pedido do utilizador para posterior discussão com o Claude. **Análise e proposta apenas: não há autorização nesta nota para implementar ou alterar configurações.**

> Atualização: o utilizador autorizou posteriormente os ensaios e a implementação. A integração passou a usar MCP nativo numa HOME privada com bwrap, em vez da ponte CLI; desde a entrada 118, o agy usa a sua conversa normal com o hook só de leitura e o servidor `hydraq`, e o bwrap foi retirado. Ver `docs/claudex.md` e a entrada correspondente de `AI_CHANGES.md` para o estado verificado. O texto abaixo preserva a análise anterior.

## Objetivo do utilizador

Permitir colaboração semelhante ao ClaudeX atual com Codex + Gemini 4 Argon (cliente Antigravity), Claude + Gemini e, eventualmente, os três. Preservar sessões simultâneas, investigação e mensagens durante o trabalho, com um documento final revisto pelos participantes. Não transformar a experiência em simples alternância de respostas independentes. A ordem dos nomes do par não determina o autor: a autoria deve ser uma escolha separada.

## Proposta do Argon e avaliação do Codex

Faz sentido reutilizar o coordenador existente e permitir escolher os participantes, mantendo Codex + Claude como predefinição. Contudo, «90% feito» e «único obstáculo» não são estimativas demonstradas.

A ponte CLI local proposta pelo Argon é uma alternativa plausível ao MCP nativo: um utilitário recebe operação/argumentos, lê a credencial específica da tarefa e faz o mesmo POST autenticado para a caixa de mensagens do coordenador. Deve usar o URL do lease, não uma porta 4318 fixa. A implementação e o funcionamento dentro da sandbox real do agy ainda não foram demonstrados.

## Pontos concretos verificados no código

- `lib/claudex.mjs` tem participantes fixos em `CX_ROLES`, mas também dependências específicas na criação, reservas, autor, instruções e retoma. Há uma renovação explícita do transporte Codex em `resume`. A generalização não se resume a substituir a constante; deve preservar também tarefas antigas e a interface.
- `lib/antigravity.mjs` anuncia `capabilities.steer: false`, mas contém um método `steer()` que lança erro de operação não suportada. `ClaudeX.notify()` verifica a existência do método, não essa capacidade. Um adaptador generalizado deve consultar capacidades reais.
- O agy não tem orientação de turno ativo no protocolo stream-json atualmente integrado. Com uma ponte acessível por ferramenta, pode enviar e consultar mensagens enquanto investiga, mas não recebe o mesmo aviso imediato que Codex/Claude. Consultas em momentos úteis (após etapas de investigação e antes de concluir) e continuações por novidade são uma proposta; não introduzir polling repetitivo ou prometer incorporação imediata.
- `Antigravity.#start()` lança o processo com `env: this.env` e reutiliza a sessão entre turnos. Ainda não injeta a credencial ClaudeX por tarefa/processo. A reutilização precisa de respeitar mudança de tarefa, geração e revogação, sem alterar o ambiente global do adaptador nem reutilizar credenciais anteriores.
- O processo usa `--sandbox` e `--mode plan`. A instalação tem `toolPermission: always-proceed`, alterado anteriormente por pedido explícito. Poder executar `run_command` não demonstra confinamento de escrita, nem isolamento de MCP externos. O equivalente às restrições específicas de Codex/Claude precisa de validação real.

## Cuidados com a ponte

- Uma variável de ambiente passada ao filho não prova «100% de isolamento». Usar credencial por tarefa/participante/geração, permissões restritas no ficheiro e revogação no coordenador; não colocar o token na linha de comandos, no prompt ou nos logs.
- Validar leitura do lease e acesso HTTP local dentro da sandbox efetiva sem alargar permissões apenas para fazer o teste passar. Confirmar também limites de transporte, erros e documentos grandes.
- Não usar um caminho de credencial determinado apenas pela pasta: várias tarefas podem partilhar o mesmo projeto. Não prometer risco zero em reinícios.
- Evitar inicialmente registar um MCP global do agy. A alternativa de servidor fixo com lease herdado exige provar propagação do ambiente e isolamento entre sessões; não está implementada.

## Próximo passo recomendado, se autorizado

Fazer primeiro uma prova pequena com Gemini + Codex, antes da generalização da interface:

1. Os dois investigam em simultâneo e enviam/leem contribuições reais durante os turnos.
2. Uma tentativa controlada de escrita é recusada sem modificar ficheiros do utilizador; ferramentas externas não contornam a restrição.
3. Pausa/retoma conserva tarefa e sessões; chamadas com a credencial antiga são rejeitadas e mensagens atrasadas não reativam trabalho.
4. Documento final, incluindo uma revisão após objeção, só é publicado com aprovação exata de ambos sobre texto e contexto atuais.

Se a prova passar, generalizar os pares; considerar três participantes depois. Preservar o ClaudeX atual e distinguir testes simulados, ensaio real e comparação de qualidade. Nesta análise não se fizeram novas chamadas aos modelos, alterações de código ou configuração, nem ensaios dessa ponte.
