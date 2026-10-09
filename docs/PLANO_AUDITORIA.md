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

- [x] **Fase 2: Concorrência e Estabilidade do Codex App-Server (P1/P2)**
  - [x] `A03` — Serialização e roteamento de turnos e approvals por threadId/turnId no codex daemon
  - [x] `A04` — Chaveamento do pool de daemons por conta/env efetivo além do cwd
  - [x] `A05` — Eliminação de unhandled rejection e verificação de abort entre RPCs
  - [x] `A58` — Deadlines com sinal de abort no handshake inicial e em todas as chamadas sendRpc
  - [x] `A59` — Paridade e aplicação de permissões/sandbox/modelo em cada turno do app-server
  - [x] `A68` — Propagação explícita de erro e verificação de status terminal no fechamento do daemon

- [x] **Fase 3: Isolamento de Worktrees, Sandboxes e Execuções CLI (P1/P2)**
  - [x] `A07` — Modo --stream na CLI passa pelo executor de worktree e orçamento
  - [x] `A08` — Transporte de baseline limpa para worktree e abort se git apply falhar
  - [x] `A09` — Confinamento estrito de patches e diffs dentro de agentRoot
  - [x] `A38` — Buffer circular com tail preservado em autoRepair
  - [x] `A39` — Proteção contra concorrência ao inspecionar ou remover worktrees ativas
  - [x] `A60` — Fechamento limpo de iteradores internos com it.return() e sinal de abort

- [x] **Fase 4: Adaptadores, Roster, MCP Bridge & Pipelines (P2)**
  - [x] `A06` — Mapeamento uniforme de permissões (read-only, plan, edit, full) em novos adaptadores
  - [x] `A31` — Alinhamento de tipos públicos RunOptions, FallbackErrorCode e allowlists
  - [x] `A36` — Cálculo consistente de sucesso e rollback em pipelines com stopOnError: false
  - [x] `A37` — Normalização de métricas de usage delta vs cumulativo no Budget.track
  - [x] `A43` — Validador de JSON schema protegido contra prototype pollution e loops em $ref '#'
  - [x] `A44` — Resolução estrita de vereditos em consensos rejeitando contradições
  - [x] `A61` — Tratamento correto de TIMEOUT e ABORTED em novos adaptadores
  - [x] `A63` — Catálogo único de nomes reservados prevenindo conflito de endpoints
  - [x] `A64` — Normalização de nomes MCP completos (mcp__agentbridge__*) no SubagentRoster
  - [x] `A69` — Capacidades de MCP filho declaradas no bridge sem quebrar com erro desconhecido
  - [x] `A70` — Rejeição explícita ou implementação de opções não suportadas em adaptadores novos
  - [x] `A72` — Detecção de empate sem consenso arbitrário no ensemble

- [x] **Fase 5: Telemetria, Quotas, Contexto & Contas (P2)**
  - [x] `A18` — Bloqueio de reentrada recursiva em compact e handoff
  - [x] `A20` — Correção do cálculo de janela de contexto evitando quedas artificiais
  - [x] `A21` — Associação correta de sessões ao effectiveAgent após fallback
  - [x] `A22` — Resolução de contexto respeitando diretórios de perfis gerenciados
  - [x] `A23` — Consulta assíncrona de contexto com timeout e cache prevenindo bloqueio do servidor
  - [x] `A24` — Política de retenção e paginação na listagem de histórico e sessões
  - [x] `A29` — Consulta de quota utilizando credenciais e perfis da conta selecionada
  - [x] `A30` — Avaliação da cota semanal (secondaryPercent) do Codex na disponibilidade
  - [x] `A41` — Distinção clara de erros/offline vs 0% de uso de quota
  - [x] `A42` — Integração automática de verificação de quota na seleção do pool de contas
  - [x] `A62` — Retomada de sessões usando o perfil e ambiente correto
  - [x] `A65` — Continuidade de sessões de fallback no agente efetivo no proxy

- [x] **Fase 6: Armazenamento, Configuração, Memória & UI Dashboard (P2/P3)**
  - [x] `A25` — Gravação atômica com substituição via renameSync em config, contas e memória
  - [x] `A26` — Consistência de backend na leitura e escrita de memória em fallback
  - [x] `A27` — Resolução de configuração e memória buscando até a raiz do repositório Git
  - [x] `A28` — Conexão ou remoção de opções inertes de configuração (defaultAgent, autoRollback)
  - [x] `A33` — Validação estrita de caminhos contra path traversal em addAccount e removeAccount
  - [x] `A34` — Inclusão do token de autenticação nas chamadas de checkpoint no dashboard
  - [x] `A35` — Eliminação de atributos style estáticos no dashboard atendendo à CSP
  - [x] `A40` — Isolamento de instâncias de proxy prevenindo compartilhamento de estado global
  - [x] `A54` — Injeção automática de regras de memória no prompt dos executores
  - [x] `A66` — Rejeição explícita de previous_response_id não suportado no responses
  - [x] `A67` — Validação estrita de max_tokens com erro 400 em valores inválidos

- [x] **Fase 7: Tooling, Installers, Release & Contratos (P2/P3)**
  - [x] `A19` — Validação estrita de SemVer e chamada segura com argumentos no release.mjs
  - [x] `A32` — Atualização sincronizada de package.json e package-lock.json no release
  - [x] `A45` — Sinalização de erro no exit code do setup quando instalações falham
  - [x] `A46` — Escopos de instalação precisos evitando afetar configurações globais no project scope
  - [x] `A47` — Propagação de cwd e validação de escopos no setup
  - [x] `A48` — Atualização transacional de MCP sem deletar configuração antes do sucesso
  - [x] `A49` — Preservação de configurações do Pi com erro ao encontrar arquivos inválidos
  - [x] `A50` — Unificação do caminho de configuração do OpenCode no Windows entre installer e doctor
  - [x] `A51` — Limpeza de timers e cancelamento no doctor e listagem de modelos
  - [x] `A52` — Suporte a CLAUDE_CONFIG_DIR no diagnóstico de login do doctor
  - [x] `A53` — Uso de process.execPath portátil na configuração de IDEs
  - [x] `A56` — Atualização do CONTRACT.md para refletir TypeScript e o ecossistema atual
  - [x] `A71` — Centralização do catálogo de agentes e desacoplamento de camadas

---

## Log de Execução e Commits
- 2026-10-09: Auditoria lida, classificada e plano inicial estruturado.
- 2026-10-09: Fase 1 (Segurança Central & Sandboxes) concluída (A01, A02, A10, A11, A12, A13, A14, A15, A16, A17, A57). Testes de aceitação `security-phase1.test.mjs`, `checkpoint.test.mjs`, `ui-checkpoints.test.mjs` e `config-permissions.test.mjs` 100% passando.
- 2026-10-09: Fase 2 (Concorrência e Estabilidade do Codex App-Server) concluída (A03, A04, A05, A58, A59, A68). Testes de aceitação `codex-phase2.test.mjs` e `codex-appserver.test.mjs` 100% passando. Commit `8ed3d4b` enviado ao GitHub.
- 2026-10-09: Fase 3 (Isolamento de Worktrees, Sandboxes e Execuções CLI) concluída (A07, A08, A09, A38, A39, A60). Testes de aceitação `phase3-isolation.test.mjs` 100% passando (6/6). Untracked files sincronizados no baseline de worktree, confinamento estrito de agentRoot em patches e headers, isolamento de índice git em diff concorrente, preservação de tail em circular buffer no autoRepair, suporte completo a worktree e budget no modo `--stream` e propagação de `.return()` nos geradores. Commit `b90c58a` enviado ao GitHub.
- 2026-10-09: Fase 4 (Adaptadores, Roster, MCP Bridge & Pipelines) concluída (A06, A31, A36, A37, A43, A44, A61, A63, A64, A69, A70, A72). Testes de aceitação `phase4-adapters-roster.test.mjs` 100% passando (10/10). Validação estrita de opções e rejeição de incompatibilidades em adaptadores (cursor, gemini, devin, grok, acp), checagem explícita de timeout/abort em child processes, integridade total de status e autoRollback em pipelines, consenso sem vencedor arbitrário em empate e prioridade estrita de rejeição, normalização de prefixos MCP completos no SubagentRoster e schema validator imune a prototype pollution e ciclos. Commit `e39ccb1` enviado ao GitHub.
- 2026-10-09: Fase 5 (Telemetria, Quotas, Contexto & Contas) concluída (A18, A20, A21, A22, A23, A24, A29, A30, A41, A42, A62, A65). Testes de aceitação `phase5-telemetry-quota.test.mjs` 100% passando (10/10). Suspensão de políticas reentrantes em handoff/compact via MAINTENANCE_POLICY, preservação da janela de contexto real sem inflação artificial para 1M, continuidade e atribuição de sessões pós-fallback ao effectiveAgent, resolução de perfis gerenciados via env, caching e limites em inspeção de contexto, paginação e retenção em histórico/sessões, suporte a verificação de quotas primárias e secundárias com flags de erro reais e rotação proativa no pool de contas. Commit `accf2df` enviado ao GitHub.
- 2026-10-09: Fase 6 (Armazenamento, Configuração, Memória & UI Dashboard) concluída (A25, A26, A27, A28, A33, A34, A35, A40, A54, A66, A67). Testes de aceitação `phase6-storage-memory-ui.test.mjs` 100% passando (10/10) e suíte consolidada de 43 testes passando. Descoberta de configuração e memória via findProjectRoot subindo diretórios até .git/.agentbridge, persistência atômica com propagação de erro explícita em config, contas e memória, arbitragem de versão mais recente de memória entre local e fallback via timestamp, injeção automática de regras de memória no prompt de execução, validação canônica de diretórios de contas contra path traversal, eliminação de atributos style inline no dashboard atendendo a CSP, inclusão obrigatória de bearer token nas rotas de checkpoint do Time Machine, isolamento completo de AgentStore e sessões entre instâncias concorrentes de proxy server, e rejeição estrita (400) de previous_response_id e max_tokens inválido.
- 2026-10-09: Fase 7 (Tooling, Installers, Release & Contratos) concluída (A19, A32, A45, A46, A47, A48, A49, A50, A51, A52, A53, A56, A71). Testes de aceitação `phase7-tooling-installers.test.mjs` 100% passando (5/5). Catálogo unificado em `catalog.ts`, caminhos do OpenCode sincronizados no Windows, preservação transacional de MCP em falha no Codex, rejeição segura de JSON inválido no Pi sem perda de arquivo, isolamento estrito de project scope no setup e propagação de flags.cwd, eliminação de timers residuais de 20s via `withTimeout` com `clearTimeout`, suporte a `CLAUDE_CONFIG_DIR`, uso de `process.execPath` em IDEs, validação estrita de SemVer e sync de `package-lock.json` no `release.mjs`, e modernização completa do `CONTRACT.md`.
- **Status Geral: 100% CONCLUÍDO (72 de 72 itens da auditoria implementados, validados por testes e documentados).**




