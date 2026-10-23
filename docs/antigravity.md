# Antigravity: acesso e diagnóstico

Verificado em 2026-10-23. O adaptador atual conserva `agy`, as sessões nativas, modelos, raciocínio e modos de acesso. Não instala ACP, não troca de conta e não configura uma API paga.

## Condições publicadas

A [FAQ da Google](https://www.antigravity.google/docs/faq/) distingue scripts/CI diretos de aplicações que envolvem `agy`: o segundo uso não é suportado em planos de consumidor, e acesso por terceiros pode levar à suspensão da conta. Pela redação publicada, este adaptador parece enquadrar-se nessa restrição; é uma interpretação, não uma autorização do fornecedor. A modalidade da conta local continua por esclarecer antes de ampliar a automação. A FAQ aponta Gemini Enterprise/Google AI Studio como alternativas; nenhuma foi configurada e a faturação mantém-se.

## O que os avisos significam

| Aviso | Evidência utilizada | Comportamento |
|---|---|---|
| Ferramenta recusada | Resultado nativo de ferramenta, factos de recusa ou diagnóstico explícito em stderr | A ação não é apresentada como executada. Uma resposta válida mantém-se, com aviso de limitação. |
| Quota ou limite | Código de quota/limite ou mensagem explícita no erro nativo ou stderr | Mostra a evidência e qualquer prazo nela comunicado. Não calcula quota restante nem assume que um erro de capacidade é quota. |
| Sem resposta | Pedido terminado sem texto de resposta | Um resultado nativo SUCCESS vazio passa a falhado. Recusas observadas continuam identificadas à parte, sem afirmar que causaram a ausência de resposta. |

Na conversa, o diagnóstico acompanha a última mensagem do pedido; se não houver resposta, aparece junto da pergunta. Nos pareceres, os tipos de aviso são visíveis mesmo com o cartão fechado. Os detalhes podem ser expandidos; segredos conhecidos são filtrados e a evidência pode ser abreviada com indicação. A seleção de um parecer transmite os avisos ao principal juntamente com o texto e os factos observados.

O [modo headless documentado](https://www.antigravity.google/docs/cli/headless/) pode recusar uma ferramenta que precisaria de confirmação e ainda assim concluir com código de saída zero. O adaptador não altera permissões globais nem ativa aprovação automática. Em processos reutilizados, os diagnósticos de stderr são separados por pedido; os avisos anteriores não são atribuídos ao pedido seguinte. Históricos antigos só permitem recuperar a evidência guardada: não é possível reconstruir stderr que nunca foi conservado.

São mantidas as escolhas existentes e não há repetição automática por estas classificações. Não se considera um número de tokens, uma resposta vazia, texto do modelo ou RESOURCE_EXHAUSTED/429 isolado como prova de quota esgotada. O ACP permanece fora desta alteração.
