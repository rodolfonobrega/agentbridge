# Plano de Ação & Rastreamento da Auditoria AgentBridge (A01 - A72)

Data de início: 2026-10-09  
Status geral: **EM PROGRESSO**  
Snapshot base: `cf50a72`

---

## Estrutura das Fases

- [x] **Fase 1: Segurança Central & Sandboxes (P1)**
  - [x] `A01` — Proxy de texto desabilita ferramentas verificavelmente em vez de texto no systemPrompt
  - [x] `A02` — Rollback via MCP valida resolvePerms (rejeita read-only/plan) e confina cwd
  - [x] `A10` — Mescla o.env com process.env na resolução de permissões e teto do operador
  - [x] `A11` — Validação estrita de esquema ao carregar .agentbridge/config.json com erro em corrupção
  - [x] `A12` — Filtro de segurança em extraArgs para Codex e Claude impedindo bypass de sandbox
  - [x] `A13` — Harness de endpoints mantém isolated: true como padrão
  - [x] `A14` — Parser robusto de IP no fetch de imagens cobrindo IPv6 mapeado e notações alternativas
  - [x] `A15` — Fixação de IP resolvido no transporte HTTP de imagens contra TOCTOU DNS rebinding
  - [x] `A16` — Proteção contra CSRF / verificação de Origin e token para mutações no dashboard
  - [x] `A17` — Rollback de checkpoint preserva staging e limpa arquivos criados pós-snapshot
  - [x] `A57` — Inclusão de config-permissions.test.mjs e descoberta de testes no package.json e CI

- [ ] **Fase 2: Concorrência e Estabilidade do Codex App-Server (P1/P2)**
  - [ ] `A03` — Serialização e roteamento de turnos e approvals por threadId/turnId no codex daemon
  - [ ] `A04` — Chaveamento do pool de daemons por conta/env efetivo além do cwd
  - [ ] `A05` — Eliminação de unhandled rejection e verificação de abort entre RPCs
  - [ ] `A58` — Deadlines com sinal de abort no handshake inicial e em todas as chamadas sendRpc
  - [ ] `A59` — Paridade e aplicação de permissões/sandbox/modelo em cada turno do app-server
  - [ ] `A68` — Propagação explícita de erro e verificação de status terminal no fechamento do daemon

- [ ] **Fase 3: Isolamento de Worktrees, Sandboxes e Execuções CLI (P1/P2)**
  - [ ] `A07` — Modo --stream na CLI passa pelo executor de worktree e orçamento
  - [ ] `A08` — Transporte de baseline limpa para worktree e abort se git apply falhar
  - [ ] `A09` — Confinamento estrito de patches e diffs dentro de agentRoot
  - [ ] `A38` — Buffer circular com tail preservado em autoRepair
  - [ ] `A39` — Proteção contra concorrência ao inspecionar ou remover worktrees ativas
  - [ ] `A60` — Fechamento limpo de iteradores internos com it.return() e sinal de abort

- [ ] **Fase 4: Adaptadores, Roster, MCP Bridge & Pipelines (P2)**
  - [ ] `A06` — Mapeamento uniforme de permissões (read-only, plan, edit, full) em novos adaptadores
  - [ ] `A31` — Alinhamento de tipos públicos RunOptions, FallbackErrorCode e allowlists
  - [ ] `A36` — Cálculo consistente de sucesso e rollback em pipelines com stopOnError: false
  - [ ] `A37` — Normalização de métricas de usage delta vs cumulativo no Budget.track
  - [ ] `A43` — Validador de JSON schema protegido contra prototype pollution e loops em $ref '#'
  - [ ] `A44` — Resolução estrita de vereditos em consensos rejeitando contradições
  - [ ] `A61` — Tratamento correto de TIMEOUT e ABORTED em novos adaptadores
  - [ ] `A63` — Catálogo único de nomes reservados prevenindo conflito de endpoints
  - [ ] `A64` — Normalização de nomes MCP completos (mcp__agentbridge__*) no SubagentRoster
  - [ ] `A69` — Capacidades de MCP filho declaradas no bridge sem quebrar com erro desconhecido
  - [ ] `A70` — Rejeição explícita ou implementação de opções não suportadas em adaptadores novos
  - [ ] `A72` — Detecção de empate sem consenso arbitrário no ensemble

- [ ] **Fase 5: Telemetria, Quotas, Contexto & Contas (P2)**
  - [ ] `A18` — Bloqueio de reentrada recursiva em compact e handoff
  - [ ] `A20` — Correção do cálculo de janela de contexto evitando quedas artificiais
  - [ ] `A21` — Associação correta de sessões ao effectiveAgent após fallback
  - [ ] `A22` — Resolução de contexto respeitando diretórios de perfis gerenciados
  - [ ] `A23` — Consulta assíncrona de contexto com timeout e cache prevenindo bloqueio do servidor
  - [ ] `A24` — Política de retenção e paginação na listagem de histórico e sessões
  - [ ] `A29` — Consulta de quota utilizando credenciais e perfis da conta selecionada
  - [ ] `A30` — Avaliação da cota semanal (secondaryPercent) do Codex na disponibilidade
  - [ ] `A41` — Distinção clara de erros/offline vs 0% de uso de quota
  - [ ] `A42` — Integração automática de verificação de quota na seleção do pool de contas
  - [ ] `A62` — Retomada de sessões usando o perfil e ambiente correto
  - [ ] `A65` — Continuidade de sessões de fallback no agente efetivo no proxy

- [ ] **Fase 6: Armazenamento, Configuração, Memória & UI Dashboard (P2/P3)**
  - [ ] `A25` — Gravação atômica com substituição via renameSync em config, contas e memória
  - [ ] `A26` — Consistência de backend na leitura e escrita de memória em fallback
  - [ ] `A27` — Resolução de configuração e memória buscando até a raiz do repositório Git
  - [ ] `A28` — Conexão ou remoção de opções inertes de configuração (defaultAgent, autoRollback)
  - [ ] `A33` — Validação estrita de caminhos contra path traversal em addAccount e removeAccount
  - [ ] `A34` — Inclusão do token de autenticação nas chamadas de checkpoint no dashboard
  - [ ] `A35` — Eliminação de atributos style estáticos no dashboard atendendo à CSP
  - [ ] `A40` — Isolamento de instâncias de proxy prevenindo compartilhamento de estado global
  - [ ] `A54` — Injeção automática de regras de memória no prompt dos executores
  - [ ] `A66` — Rejeição explícita de previous_response_id não suportado no responses
  - [ ] `A67` — Validação estrita de max_tokens com erro 400 em valores inválidos

- [ ] **Fase 7: Tooling, Installers, Release & Contratos (P2/P3)**
  - [ ] `A19` — Validação estrita de SemVer e chamada segura com argumentos no release.mjs
  - [ ] `A32` — Atualização sincronizada de package.json e package-lock.json no release
  - [ ] `A45` — Sinalização de erro no exit code do setup quando instalações falham
  - [ ] `A46` — Escopos de instalação precisos evitando afetar configurações globais no project scope
  - [ ] `A47` — Propagação de cwd e validação de escopos no setup
  - [ ] `A48` — Atualização transacional de MCP sem deletar configuração antes do sucesso
  - [ ] `A49` — Preservação de configurações do Pi com erro ao encontrar arquivos inválidos
  - [ ] `A50` — Unificação do caminho de configuração do OpenCode no Windows entre installer e doctor
  - [ ] `A51` — Limpeza de timers e cancelamento no doctor e listagem de modelos
  - [ ] `A52` — Suporte a CLAUDE_CONFIG_DIR no diagnóstico de login do doctor
  - [ ] `A53` — Uso de process.execPath portátil na configuração de IDEs
  - [ ] `A56` — Atualização do CONTRACT.md para refletir TypeScript e o ecossistema atual
  - [ ] `A71` — Centralização do catálogo de agentes e desacoplamento de camadas

---

## Log de Execução e Commits
- 2026-10-09: Auditoria lida, classificada e plano inicial estruturado.
- 2026-10-09: Fase 1 (Segurança Central & Sandboxes) concluída (A01, A02, A10, A11, A12, A13, A14, A15, A16, A17, A57). Testes de aceitação `security-phase1.test.mjs`, `checkpoint.test.mjs`, `ui-checkpoints.test.mjs` e `config-permissions.test.mjs` 100% passando.
