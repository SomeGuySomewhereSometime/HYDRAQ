# Continuidade da integração Codex original

Estado: implementação em curso, guardada a pedido do utilizador para continuar com Astra. Não integrada no checkout principal nem ativada na porta 4318.

Base: 8f25180 guarda o estado anterior completo, autorizado pelo utilizador. Esta branch codex/native-terminal contém apenas a integração em curso. Cópia de desenvolvimento original: /tmp/hydraq-native-20261023 (tem node_modules/ws instalado).

Implementação: adaptador WebSocket sobre socket Unix privado -> executor Codex stdio existente; pedidos passam por Providers.send para preservar memória, MCP, passagens e revisões. Um controlador por grupo, recusa de operações não suportadas, associação explícita de sessões e incorporação de histórico/turnos/perguntas externos. UI nas configurações. Desktop ainda indisponível.

Verificado: 87 testes específicos passaram antes das últimas correções adicionais (histórico, integração, passagens, revisões); a primeira suite completa deu 330/331, sendo a única falha um caminho de prova errado no novo teste, entretanto corrigido e aprovado. Depois foram feitas melhorias adicionais que AINDA PRECISAM de nova validação completa. Logs: /tmp/hydraq-native-check2.log (87/87), /tmp/hydraq-native-check-tests.log (65/65), /tmp/hydraq-native-new-tests.log (7/7), /tmp/hydraq-native-all-tests.log (330/331 antes da correção do teste). Não declarar suite final aprovada.

Ensaio real: /tmp/hydraq-native-live-J6cnCm. Codex 0.159.0 e GPT-6.1-Sol, autenticação ChatGPT no servidor sem copiar credenciais. Três turnos concluídos: HYDRAQ_SEED_OK, MCP get_project_memory devolveu MEMORIA_NATIVA_731, e TUI_FINAL_842. O TUI mostra um aviso de reconexão durante novos pedidos; a resposta final foi confirmada no estado do backend e a resposta MCP apareceu no histórico renderizado, mas falta confirmar a apresentação final imediata do último turno e investigar o aviso de reconexão. Não dar esta questão por resolvida.

Desktop: instância real isolada com perfil/CODEX_HOME próprios e sem credenciais copiadas, ligada ao adaptador através de uma ponte temporária. A UI abriu; o adaptador recusou getAuthStatus e operações de gestão/configuração. Não validada execução completa nem habilitado botão desktop. Provas desktop-authenticated.json, desktop-methods.json e desktop-0.png na pasta do ensaio. Um ensaio anterior direto ao servidor nativo tinha demonstrado leitura da mesma thread; artefactos anteriores em /home/sauron/.codex/visualizations/2026/10/23/01a16880-5268-76a0-b2f3-ac4f370c1c46/auditoria-codex/.

Próximos passos: rever o código em curso, completar os testes de compatibilidade reais do TUI e de reconexão/reinício/aprovações pendentes; adicionar testes significativos para as últimas correções; testar UI Grafite/Atelier e móvel com controlo efetivo/associação; executar suite final, sintaxe e diff. Só depois integrar no checkout principal, atualizar AI_CHANGES com resultados reais, considerar ativação quando livre e fazer commit final. Manter recusa explícita das funcionalidades TUI não suportadas, sem prometer paridade completa com desktop.

Paragem: backend temporário PID 930539 encerrado por SIGTERM após confirmar estado completed, três turnos; instâncias desktop de ensaio encerradas pelos scripts. Aplicação ativa preservada. Não reiniciar serviços existentes nem inferir que esta funcionalidade já está ativa.
