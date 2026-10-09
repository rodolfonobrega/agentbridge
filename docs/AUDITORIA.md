# Correções e melhorias do AgentBridge

Base: código do commit `437a68b`, auditado em 09/10/2026. Evidências de análise estática; não houve execução de testes ou de agentes externos pelo sistema auditado. Os itens condicionais indicam seu gatilho. Alterações concorrentes em `src/cli/install.ts` e `src/cli/setup.ts` surgiram depois da leitura desses arquivos; suas referências correspondem ao snapshot auditado.

Prioridades: **P1** — segurança, perda de trabalho ou execução indevida; **P2** — comportamento incorreto, confiabilidade e experiência de uso; **P3** — clareza e manutenção.

## P1 — Corrigir primeiro

### A01 — Proxy de texto concede execução completa a agentes com ferramentas

- **Problema e impacto:** No modo API, permissions é full. Apenas Claude recebe --tools vazio; para Codex/Pi/OpenCode a restrição NO_TOOLS é texto no systemPrompt. Um prompt que induza ferramentas pode acessar arquivos ou comandos com as credenciais locais.
- **Evidência:** `src/server/common.ts:265`; `src/server/common.ts:362`; `src/server/common.ts:372`.
- **Correção proposta:** Desabilitar ferramentas de forma verificável por adaptador e restringir permissões; exigir modo agent autorizado para execução.

### A02 — Rollback via MCP ignora o teto de permissões

- **Problema e impacto:** callAny checkpoint_rollback não verifica resolvePerms; executa checkout/clean mesmo com bridge limitado a read-only/plan. cwd também é escolhido pelo chamador sem vínculo ao workspace autorizado.
- **Evidência:** `src/bridge/mcp.ts:317`; `src/bridge/mcp.ts:712`; `src/bridge/mcp.ts:717`.
- **Correção proposta:** Autorizar mutações de checkpoint segundo política efetiva, validar raiz e negar rollback em read-only/plan; limitar exposição da ferramenta.

### A03 — Codex app-server mistura turnos e permissões concorrentes

- **Problema e impacto:** Daemon tem um activeTurn e pool por cwd. Duas chamadas substituem esse contexto; todas notificações/approvals vão para o turno mais recente, sem correlação por thread/turn. Texto, uso e decisão de permissão podem pertencer à chamada errada.
- **Evidência:** `src/adapters/codex-daemon.ts:99`; `src/adapters/codex-daemon.ts:222`; `src/adapters/codex-daemon.ts:335`; `src/adapters/codex-daemon.ts:452`.
- **Correção proposta:** Serializar turnos por daemon ou rotear estado por threadId/turnId; vincular approval à política da solicitação que o originou.

### A04 — Codex app-server reutiliza a identidade da primeira conta

- **Problema e impacto:** Pool usa só cwd. ensureStarted recebe env no primeiro spawn e não reinicia processo para outro CODEX_HOME; chamadas posteriores na mesma pasta podem usar conta anterior embora peçam outra.
- **Evidência:** `src/adapters/codex-daemon.ts:112`; `src/adapters/codex-daemon.ts:317`; `src/adapters/codex-daemon.ts:452`.
- **Correção proposta:** Chavear daemon por perfil/identidade e configuração de segurança; impedir reuso quando ambiente efetivo muda.

### A05 — Cancelamento do app-server pode rejeitar Promise sem tratamento e deixar tarefa ativa

- **Problema e impacto:** donePromise nunca é aguardada ou recebe catch, mas timeout/abort chama doneReject. Pode produzir unhandled rejection. Cancelamento antes de turnId não interrompe o turno e o código continua enviando turn/start.
- **Evidência:** `src/adapters/codex-daemon.ts:322`; `src/adapters/codex-daemon.ts:345`; `src/adapters/codex-daemon.ts:363`; `src/adapters/codex-daemon.ts:409`.
- **Correção proposta:** Remover Promise redundante ou observar rejeição; checar cancelamento entre RPCs e interromper/encerrar processo ao cancelar durante início.

### A06 — Adaptadores novos não implementam modos restritos aceitos

- **Problema e impacto:** Cursor/Gemini/Devin/Grok distinguem apenas full das demais permissões. read-only, plan e edit não recebem sandbox/allowlist específicos; dependem dos defaults do CLI e podem carregar configurações locais. A garantia uniforme de restrição não está implementada nesses adaptadores.
- **Evidência:** `src/adapters/cursor.ts:23`; `src/adapters/gemini.ts:29`; `src/adapters/devin.ts:22`; `src/adapters/grok.ts:23`.
- **Correção proposta:** Implementar mapeamento verificável de cada nível, isolamento e offline; rejeitar modo cujo contrato não possa ser cumprido.

### A07 — Modo stream da CLI ignora isolamento e orçamento pedidos

- **Problema e impacto:** O ramo --stream chama cliGen diretamente e pula exec/runBudgeted/runInWorktree. --stream --worktree pode executar no diretório real; max-cost/max-tokens/max-time também não limitam essa execução.
- **Evidência:** `src/cli/main.ts:122`; `src/cli/main.ts:128`.
- **Correção proposta:** Fazer streaming atravessar o mesmo executor de worktree/orçamento; rejeitar combinações não suportadas antes de iniciar.

### A08 — Worktree perde o teto local e pode usar uma base incompleta

- **Problema e impacto:** Só git diff HEAD e skills especiais entram na worktree; untracked, incluindo .agentbridge/config.json/memory.json e fontes recém-criados, ficam de fora. Erro de git apply é ignorado e usa HEAD silenciosamente. Política de execução passa a ser resolvida no sandbox.
- **Evidência:** `src/extras/worktree.ts:56`; `src/extras/worktree.ts:64`; `src/server/agent.ts:148`.
- **Correção proposta:** Resolver política na origem e transportar de forma imutável; incluir arquivos relevantes no snapshot e abortar se a base não puder ser reproduzida.

### A09 — agentRoot em subdiretório não limita diffs e aplicação ao diretório autorizado

- **Problema e impacto:** A validação aceita origem sob agentRoot, mas cria worktree do repo inteiro e aplica diff no topo Git. Com full ou adaptador cujo edit não confina cwd, agente pode editar caminhos irmãos e o apply os aplica fora de agentRoot.
- **Evidência:** `src/server/agent.ts:94`; `src/extras/worktree.ts:45`; `src/extras/worktree.ts:105`; `src/server/agent.ts:253`.
- **Correção proposta:** Confinar sandbox e validar todos os caminhos do patch contra a raiz autorizada, inclusive links e renames.

### A10 — Permissões do chamador podem desaparecer quando se passa env

- **Problema e impacto:** validateOptions resolve o teto usando o.env || process.env, enquanto spawnProc mescla o.env ao ambiente herdado. Um env parcial (inclusive o perfil inserido pela CLI) faz a validação ignorar AGENTBRIDGE_PERMS_CEILING e AGENTBRIDGE_HOME do processo.
- **Evidência:** `src/index.ts:143`; `src/core/spawn.ts:226`; `src/cli/main.ts:117`.
- **Correção proposta:** Resolver política com ambiente efetivo mesclado e manter limites do operador separados das variáveis configuráveis do agente.

### A11 — Configuração inválida pode liberar o teto de permissões

- **Problema e impacto:** JSON inválido vira configuração vazia; permissionsCeiling lido do arquivo não é validado. Um valor inválido produz PERMISSION_RANK[ceiling] undefined e a comparação não bloqueia full.
- **Evidência:** `src/core/config.ts:32`; `src/core/config.ts:89`; `src/core/config.ts:127`.
- **Correção proposta:** Validar esquema ao carregar; recusar executar com política corrompida e informar arquivo/erro.

### A12 — extraArgs pode sobrescrever sandbox e ferramentas permitidas

- **Problema e impacto:** Codex e Claude concatenam extraArgs depois das opções de segurança, sem filtro equivalente às guardas Pi/agy. API pública pode pedir read-only e passar override de sandbox/config/permissão; a aceitação exata de flags duplicadas depende do CLI.
- **Evidência:** `src/adapters/codex.ts:102`; `src/adapters/codex.ts:123`; `src/adapters/claude.ts:86`; `src/adapters/claude.ts:119`.
- **Correção proposta:** Bloquear flags/configs que alterem política e garantir restrições finais; não oferecer escape de segurança sob teto restrito.

### A13 — Harness de endpoint reativa hooks/configuração do perfil por padrão

- **Problema e impacto:** runWithHarness força isolated false ao delegar ao Claude quando caller não passa valor. Isso mantém hooks/settings/commands reais habilitados, inclusive em read-only/edit, e contraria isolamento do adaptador Claude direto.
- **Evidência:** `src/adapters/endpoint.ts:208`; `src/adapters/claude.ts:79`.
- **Correção proposta:** Manter isolamento como padrão também no harness; permitir recursos selecionados por política explícita sem carregar hooks arbitrários.

### A14 — Fetch de imagens aceita IPv4 privado em IPv6 mapeado

- **Problema e impacto:** isPrivateIp só reconhece ::ffff: seguido de IPv4 decimal. ::ffff:7f00:1 representa loopback, mas passa pela checagem. A URL fornecida pelo cliente pode levar a serviços internos.
- **Evidência:** `src/server/images.ts:15`; `src/server/images.ts:66`.
- **Correção proposta:** Normalizar IPs com parser apropriado e bloquear todas as representações equivalentes de faixas privadas.

### A15 — Validação DNS e conexão de imagem usam resoluções distintas

- **Problema e impacto:** assertPublic faz lookup, depois fetch resolve o host novamente. Domínio controlado que alterna respostas entre as duas etapas pode levar a IP privado. É um risco pelo fluxo de código, sem exploração executada.
- **Evidência:** `src/server/images.ts:35`; `src/server/images.ts:67`.
- **Correção proposta:** Fixar o endereço validado no transporte e revalidar cada redirect; limitar portas/destinos conforme a necessidade do produto.

### A16 — Dashboard permite rollback sem proteção contra requisições de outro site

- **Problema e impacto:** Token é opcional, POST não valida Origin/CSRF e cwd é livre. Se um site souber um checkpointId válido, pode submeter POST simples ao dashboard local sem consentimento no botão. A proteção de Host não impede esse cenário.
- **Evidência:** `src/ui/server.ts:112`; `src/ui/server.ts:168`; `src/ui/server.ts:257`.
- **Correção proposta:** Exigir autenticação e verificação de origem para mutações; fixar repo permitido e tornar operações de escrita um modo explícito.

### A17 — Rollback de checkpoint muda staging e não remove arquivos tracked posteriores

- **Problema e impacto:** git checkout snapshot -- . escreve no índice real e só restaura caminhos existentes no snapshot. Arquivo que foi criado e adicionado ao índice depois do checkpoint pode permanecer; git clean -fd não o remove porque já está tracked no índice. A limpeza ainda apaga untracked novos sem preview.
- **Evidência:** `src/extras/checkpoint.ts:180`.
- **Correção proposta:** Restaurar a árvore completa com índice temporário preservando o staging original; calcular arquivos posteriores e mostrar plano de remoção antes de rollback.

### A18 — Compactação e handoff podem reaplicar a política que os acionou

- **Problema e impacto:** handoff resume/forka a mesma sessão via askWithTelemetry sem desativar hard/hardAction. Com hardAction=handoff persistido, isso volta ao mesmo handoff antes de rodar o resumidor. compact desativa apenas warn; hard pode bloquear a recuperação e autoCompact persistido pode acionar nova compactação.
- **Evidência:** `src/telemetry/track.ts:40`; `src/telemetry/track.ts:46`; `src/telemetry/track.ts:122`; `src/telemetry/context.ts:236`; `src/telemetry/context.ts:323`.
- **Correção proposta:** Executar manutenção com guarda contra reentrada e política de contexto suspensa; preservar permissões e cancelamento.

### A19 — Versão explícita no script de release entra em comando de shell sem validação completa

- **Problema e impacto:** bumpVersion aceita qualquer string começando X.Y.Z; depois nextVersion é interpolado em git commit/tag via execSync. Sufixos com metacaracteres podem virar comandos, além de gerar versões inválidas.
- **Evidência:** `scripts/release.mjs:47`; `scripts/release.mjs:15`; `scripts/release.mjs:138`.
- **Correção proposta:** Validar toda a string SemVer e usar execFileSync com argv para Git; atualizar versão e lockfile juntos.

## P2 — Corrigir no funcionamento e nos fluxos

### A20 — O percentual de contexto cai artificialmente quando excede a janela

- **Problema e impacto:** ctxView aumenta a janela para pelo menos 1 milhão quando tokens > win. Uma sessão acima de 200 mil pode aparecer em aproximadamente 20%, mascarando warnings e hard limits.
- **Evidência:** `src/telemetry/stats.ts:535`.
- **Correção proposta:** Manter a janela conhecida; indicar overflow ou medição inconsistente em campo separado.

### A21 — Fallback associa a sessão ao agente original na telemetria

- **Problema e impacto:** finish registra fallback.used mas não muda rec.agent antes de foldIntoSession. Uma resposta do agente B é persistida sob A/sessionId de B; histórico, contexto e handoff inferem o proprietário errado.
- **Evidência:** `src/telemetry/stats.ts:371`; `src/telemetry/stats.ts:386`; `src/telemetry/stats.ts:448`.
- **Correção proposta:** Guardar requestedAgent e effectiveAgent; agregar sessão e ler contexto usando effectiveAgent.

### A22 — Leitura de contexto ignora perfis gerenciados

- **Problema e impacto:** readSessionContext procura sempre em homeDir/.claude ou .codex; não recebe CLAUDE_CONFIG_DIR/CODEX_HOME do run. Sessões de contas gerenciadas caem em estimativas ou não são encontradas.
- **Evidência:** `src/telemetry/stats.ts:166`; `src/telemetry/stats.ts:175`; `src/telemetry/stats.ts:235`; `src/core/accounts.ts:295`.
- **Correção proposta:** Persistir identidade da conta e diretório de sessão; usar o ambiente efetivo do run na medição e manutenção.

### A23 — Consulta de histórico pode bloquear todo o servidor

- **Problema e impacto:** Ler contexto OpenCode executa spawnSync export com timeout de 25 segundos para cada sessão. stats faz isso em sequência, e o dashboard chama stats dentro do handler HTTP síncrono.
- **Evidência:** `src/telemetry/stats.ts:213`; `src/telemetry/stats.ts:487`; `src/telemetry/stats.ts:528`; `src/ui/server.ts:185`.
- **Correção proposta:** Consultar contexto de modo assíncrono com cache/limites de concorrência e timeout global; servir último snapshot disponível.

### A24 — Histórico cresce sem retenção e é relido integralmente

- **Problema e impacto:** listTrackedRuns/listSessions leem todos os JSONs antes de filtrar ou aplicar runLimit. sweep limpa o registro bridge, não telemetry/runs ou endpoint-sessions; o painel fica progressivamente caro e dados de prompts permanecem indefinidamente.
- **Evidência:** `src/telemetry/stats.ts:505`; `src/telemetry/stats.ts:514`; `src/telemetry/stats.ts:606`; `src/bridge/runs.ts:131`.
- **Correção proposta:** Adicionar retenção, exclusão e paginação para cada armazenamento; filtrar por índice antes de carregar conteúdo.

### A25 — Escrita de configuração e contas não é atômica

- **Problema e impacto:** config cria tmp mas grava diretamente no destino e engole falha; accounts tenta require em ESM, cai no catch e também grava direto. Memória grava diretamente. Leitores podem ver JSON parcial e atualizações concorrentes por leitura-modificação-escrita podem se perder.
- **Evidência:** `src/core/config.ts:42`; `src/core/accounts.ts:54`; `src/telemetry/memory.ts:83`.
- **Correção proposta:** Usar renameSync importado, substituição atômica e lock/versionamento para updates; propagar erros de gravação.

### A26 — Memória no fallback pode ficar escondida atrás de uma cópia local antiga

- **Problema e impacto:** AGENTBRIDGE_MEMORY_FALLBACK=1 grava só no fallback, porém loadMemory continua priorizando arquivo local existente. Regra recém-adicionada parece desaparecer quando há duas cópias.
- **Evidência:** `src/telemetry/memory.ts:47`; `src/telemetry/memory.ts:91`.
- **Correção proposta:** Usar a mesma seleção de backend na leitura e escrita; prever migração e resolução explícita de cópias.

### A27 — Configuração de projeto muda quando o comando roda em subdiretório

- **Problema e impacto:** Config e memória são buscadas no cwd exato. Configurar no root e rodar em src perde regras/teto local, embora skills já resolvam ancestrais via findGitRoot.
- **Evidência:** `src/core/config.ts:29`; `src/core/config.ts:59`; `src/telemetry/memory.ts:30`.
- **Correção proposta:** Definir escopo de projeto pela raiz Git com overrides locais explícitos; mostrar origem da configuração efetiva.

### A28 — Configuração anuncia opções sem efeito

- **Problema e impacto:** defaultAgent é salvo e mostrado, mas nenhum executor o consome; cmdRun ainda exige agente. autoRollback no config global/projeto também não é lido por repair/pipeline.
- **Evidência:** `src/cli/config.ts:47`; `src/cli/config.ts:58`; `src/core/config.ts:20`.
- **Correção proposta:** Conectar chaves aos executores ou rejeitar/remover opções inertes; validar nomes desconhecidos e mostrar valores efetivos.

### A29 — Quota por conta não consulta a conta selecionada

- **Problema e impacto:** account quota itera perfis mas chama getProactiveQuotaStatus somente com agent, reutilizando o mesmo token de processo ou dummy. Contas diferentes recebem a mesma consulta; login OAuth gerenciado não alimenta o prober.
- **Evidência:** `src/cli/accounts.ts:138`; `src/quota/proactive.ts:255`.
- **Correção proposta:** Usar credencial e identidade do perfil com acesso seguro; distinguir conta sem suporte ou sem credencial.

### A30 — Quota semanal Codex é ignorada na decisão de disponibilidade

- **Problema e impacto:** parseCodexUsage calcula secondaryPercent, mas getProactiveQuotaStatus só compara primaryPercent. Conta com cota semanal esgotada ainda aparece OK.
- **Evidência:** `src/quota/proactive.ts:105`; `src/quota/proactive.ts:278`.
- **Correção proposta:** Avaliar todas as janelas relevantes e retornar qual limite bloqueia com seu reset.

### A31 — Tipos públicos permitem chamadas que o runtime rejeita

- **Problema e impacto:** FallbackErrorCode inclui BAD_OPTION/ABORTED, mas validateOptions os rejeita em fallbackOn. RunOptions aceita qualquer chave, mas runtime usa allowlist e rejeita writableRoots que o adaptador Codex aceita diretamente. Contrato não identifica capacidades por adaptador.
- **Evidência:** `src/types/index.ts:20`; `src/types/index.ts:72`; `src/index.ts:116`; `src/index.ts:135`; `src/adapters/codex.ts:161`.
- **Correção proposta:** Alinhar tipos e validação; declarar extensões específicas e capacidades suportadas sem index signature genérica.

### A32 — Release muda package.json sem atualizar a versão do lockfile

- **Problema e impacto:** O script altera package.json, mas só adiciona package-lock.json ao commit se já tracked; nunca atualiza version do lock e packages[''].version.
- **Evidência:** `scripts/release.mjs:95`; `scripts/release.mjs:137`; `package-lock.json:3`.
- **Correção proposta:** Fazer bump que atualize ambos os arquivos e conferir sua consistência antes de criar tag.

### A33 — Isolamento das contas precisa de validação de caminhos e erros explícitos

- **Problema e impacto:** addAccount valida name mas não agent, usado no caminho de profiles; copyCurrent ignora falhas e ainda registra perfil. removeAccount usa profileDir do manifesto para rmSync sem verificar se fica sob profiles.
- **Evidência:** `src/core/accounts.ts:31`; `src/core/accounts.ts:135`; `src/core/accounts.ts:155`; `src/core/accounts.ts:226`.
- **Correção proposta:** Validar agente suportado e caminho canônico de perfil; impedir purge fora da raiz gerenciada e informar cópia/remoção incompleta.

### A34 — Checkpoint no dashboard não envia token de autenticação

- **Problema e impacto:** As chamadas de stats usam api com Bearer, mas checkpoints/list/diff/rollback usam fetch direto. Com ab ui --token, painel de checkpoints falha com 401 mesmo aberto com ?token.
- **Evidência:** `src/ui/app.js:5`; `src/ui/app.js:270`; `src/ui/app.js:306`; `src/ui/app.js:319`.
- **Correção proposta:** Usar cliente HTTP único que acrescente token, confira status e apresente erro na tela; remover token da URL após capturá-lo.

### A35 — Estilos estáticos do dashboard são incompatíveis com sua CSP

- **Problema e impacto:** CSP permite style-src self sem unsafe-inline, mas HTML usa atributos style para esconder diff-panel e destacar rollback. Esses atributos não estão autorizados e o layout/estado inicial pode divergir. Não se afirma aqui bloqueio de alterações via CSSOM.
- **Evidência:** `src/ui/server.ts:17`; `src/ui/index.html:104`; `src/ui/index.html:108`.
- **Correção proposta:** Mover atributos estáticos a classes no app.css e usar hidden para estado de visibilidade.

### A36 — Pipeline com stopOnError false pode retornar sucesso após falhas

- **Problema e impacto:** failedStepId só é definido quando a execução para; success final é !failedStepId. Continuar após erro pode retornar success true e impedir autoRollback apesar de etapas falhas.
- **Evidência:** `src/extras/pipeline.ts:165`; `src/extras/pipeline.ts:193`.
- **Correção proposta:** Calcular sucesso por todos resultados; separar continuidade, falha e rollback.

### A37 — Orçamento usa semântica de usage incompatível entre adaptadores

- **Problema e impacto:** Budget.track substitui uso por run; Codex emite usage incremental por turno. Totais de vários turnos não são detectados durante a execução e só aparecem ao final.
- **Evidência:** `src/extras/budget.ts:61`; `src/adapters/codex.ts:219`; `src/extras/budget.ts:133`.
- **Correção proposta:** Definir usage delta vs cumulativo no contrato, normalizar antes de Budget e conferir o limite durante cada evento.

### A38 — AutoRepair mantém toda a saída do comando em RAM

- **Problema e impacto:** runTestCommand acumula outLines integralmente; truncamento para prompt acontece depois. Comando muito verboso pode consumir memória ilimitada apesar da intenção de buffer limitado.
- **Evidência:** `src/extras/repair.ts:87`; `src/extras/repair.ts:116`.
- **Correção proposta:** Aplicar buffer circular durante leitura e limitar bytes, preservando tail e indicação de truncamento.

### A39 — Ler ou apagar sandbox ativa pode interferir na execução

- **Problema e impacto:** GET diff executa git add -A no índice da sandbox durante run; DELETE remove worktree sem checar busy. Consultar ou limpar enquanto agente usa Git pode alterar staging ou apagar seu cwd.
- **Evidência:** `src/server/agent.ts:227`; `src/server/agent.ts:235`; `src/extras/worktree.ts:105`.
- **Correção proposta:** Usar índice temporário para diff; recusar DELETE busy ou cancelar e aguardar término antes de limpar.

### A40 — Instâncias de proxy compartilham estado e encerramento

- **Problema e impacto:** runs/bySession e sessions são globais ao módulo. Dois proxies no mesmo processo podem compartilhar sessões/sandboxes; close de um remove agent runs de todos. Mapas não têm namespace por instância.
- **Evidência:** `src/server/agent.ts:22`; `src/server/agent.ts:52`; `src/server/common.ts:328`; `src/server/index.ts:147`.
- **Correção proposta:** Criar estado por startProxy e descartar somente recursos próprios; limitar retenção e limpar sessões.

### A41 — Falhas de quota são exibidas como disponibilidade confirmada

- **Problema e impacto:** HTTP rejeitado, timeout ou credencial dummy resultam em percentuais zero; okToProceed true e formatQuotaStatus OK. offline usa fixture de exemplo como se fosse medição real.
- **Evidência:** `src/quota/proactive.ts:158`; `src/quota/proactive.ts:218`; `src/quota/proactive.ts:259`.
- **Correção proposta:** Representar unknown/error/offline separadamente, com fonte e data; não inventar percentuais em produção.

### A42 — Rotação proativa do pool existe apenas como função desconectada

- **Problema e impacto:** updateQuota não tem chamada no src. O pool continua escolhendo contas próximas de esgotamento até erro, apesar da promessa de sondagem automática e cooldown proativo.
- **Evidência:** `src/server/pool.ts:126`; `README.md:225`.
- **Correção proposta:** Integrar consulta por conta à seleção e refresh do pool; mostrar medição desconhecida sem confundi-la com quota livre.

### A43 — Validador de schema aceita propriedades herdadas e recursa sem limite

- **Problema e impacto:** required usa in e properties também; nomes herdados podem passar indevidamente. $ref '#' chama validate na mesma referência sem consumir estrutura, até RangeError; schemas de tools chegam a esse validador.
- **Evidência:** `src/extras/schema.ts:21`; `src/extras/schema.ts:67`.
- **Correção proposta:** Usar Object.hasOwn e limites de profundidade/visitas por schema+valor; rejeitar referências sem resolução válida com erro 400.

### A44 — Veredito contraditório pode ser aprovado

- **Problema e impacto:** JSON com verdict REJECTED e approved true é aprovado pelo OR. Isso torna a revisão permissiva mesmo quando o campo principal rejeita.
- **Evidência:** `src/extras/consensus.ts:116`.
- **Correção proposta:** Validar contrato do verdict e rejeitar inconsistências; definir precedência inequívoca para rejeição.

### A45 — Setup anuncia conclusão mesmo quando instalações falham

- **Problema e impacto:** results captura falhas mas não alimenta resumo/exit code. --yes sem CLIs pode tentar quatro agentes, falhar e terminar com Setup Complete e saída 0.
- **Evidência:** `src/cli/setup.ts:533`; `src/cli/setup.ts:557`; `src/cli/setup.ts:600`.
- **Correção proposta:** Resumir alvos bem-sucedidos/falhos e retornar erro quando instalação solicitada falhar; orientar instalação ausente.

### A46 — Escopo Project do wizard pode alterar MCP global

- **Problema e impacto:** Codex/agy/Pi registram MCP global independentemente do scope; apenas destino da skill muda. Usuário escolhe project e altera configuração de todos projetos.
- **Evidência:** `src/cli/setup.ts:383`; `src/cli/install.ts:108`; `src/cli/install.ts:126`; `src/cli/install.ts:140`.
- **Correção proposta:** Oferecer apenas escopos realmente suportados por agente; implementar config local quando possível e mostrar destino antes/depois.

### A47 — Setup descarta cwd e normaliza scopes inválidos silenciosamente

- **Problema e impacto:** installFlags não inclui flags.cwd; --scope project --cwd outroRepo instala usando cwd do processo. Scope local vira user no modo não interativo.
- **Evidência:** `src/cli/setup.ts:534`; `src/cli/setup.ts:548`; `src/cli/install.ts:67`.
- **Correção proposta:** Encaminhar cwd e validar scope/permissions explicitamente, sem substituir entradas inválidas por defaults amplos.

### A48 — Reinstalação pode apagar registro MCP anterior antes de falhar

- **Problema e impacto:** Remove antigo registro antes do add; se add falha, a configuração funcional anterior se perde. O processo não restaura a entrada antiga.
- **Evidência:** `src/cli/install.ts:111`; `src/cli/install.ts:129`; `src/cli/install.ts:257`.
- **Correção proposta:** Fazer atualização transacional com snapshot da entrada anterior e restauração em erro; evitar remove antes de validar instalação.

### A49 — Instalação Pi sobrescreve configuração ilegível como vazia

- **Problema e impacto:** Todo erro de read/JSON vira mcpServers vazio e o arquivo é substituído. JSON inválido ou falha de leitura pode apagar outros MCPs.
- **Evidência:** `src/cli/install.ts:144`; `src/cli/install.ts:158`.
- **Correção proposta:** Tratar somente ENOENT como arquivo novo; recusar escrita em config existente inválida e informar recuperação.

### A50 — Installer e doctor discordam do caminho OpenCode no Windows

- **Problema e impacto:** Installer usa XDG_CONFIG_HOME ou ~/.config, enquanto doctor usa LOCALAPPDATA no Windows. Diagnóstico pode inspecionar outra configuração e contradizer instalação.
- **Evidência:** `src/cli/install.ts:169`; `src/extras/doctor.ts:97`.
- **Correção proposta:** Centralizar resolução por plataforma/override e fazer ambos exibirem arquivo efetivo; validar compatibilidade com o CLI instalado.

### A51 — Doctor e listagem de modelos deixam timers vivos após resposta

- **Problema e impacto:** Promise.race cria timeout de 20 segundos sem clearTimeout/unref. Mesmo quando models responde rapidamente, timer mantém processo CLI vivo; a consulta também não cancela trabalho que perdeu a race.
- **Evidência:** `src/extras/doctor.ts:201`; `src/server/common.ts:132`.
- **Correção proposta:** Usar timeout cancelável em finally e sinal de cancelamento no prober; evitar espera após relatório.

### A52 — Diagnóstico de login ignora diretório de perfil Claude

- **Problema e impacto:** Doctor procura login em paths fixos de homedir, embora execução/instalação aceitem CLAUDE_CONFIG_DIR. Perfil autenticado pode ser reportado como ausente.
- **Evidência:** `src/extras/doctor.ts:12`; `src/core/accounts.ts:295`.
- **Correção proposta:** Usar resolved profile/account env compartilhado no diagnóstico e na execução; distinguir ausência de arquivo de login inválido.

### A53 — Configuração IDE depende de node no PATH do aplicativo

- **Problema e impacto:** installIde salva command node literal; outros installers usam process.execPath. IDE aberto pelo menu pode não herdar PATH do terminal/version manager.
- **Evidência:** `src/cli/install-ide.ts:181`.
- **Correção proposta:** Persistir caminho efetivo do Node, com opção explícita para override portátil.

### A54 — Memória cadastrada não é injetada automaticamente

- **Problema e impacto:** formatMemoryForPrompt só aparece como definição/exports; nenhum executor a chama. Usuário registra regras supondo que run/ask as recebem, mas a promessa não é implementada.
- **Evidência:** `src/telemetry/memory.ts:179`; `src/index.ts:430`; `README.md:329`; `docs/REFERENCE.md:842`.
- **Correção proposta:** Integrar memória no executor comum com controle de confiança/tamanho e mostrar se foi aplicada; alinhar documentação.

### A55 — Documentação conflita sobre defaults e garantias de segurança

- **Problema e impacto:** Guias dizem full por padrão e prometem edit confinado ao cwd/sem Bash para todos; runtime usa read-only por padrão e SECURITY ressalva que Pi não tem sandbox e edit pode sair do cwd. offline é descrito como air-gap embora execução de modelo e shell full possam usar rede.
- **Evidência:** `README_AI.md:10`; `docs/REFERENCE.md:281`; `docs/REFERENCE.md:376`; `SECURITY.md:7`; `skills/agentbridge-delegate/SKILL.md:47`.
- **Correção proposta:** Publicar matriz única por agente/transporte para defaults, ferramentas, rede e confinamento; trocar garantias universais por comportamento efetivo.

### A56 — CONTRACT obrigatório descreve uma arquitetura ultrapassada

- **Problema e impacto:** Exige .mjs, zero build, três adaptadores e script progress inexistente; repositório atual usa TypeScript, tsc e dez adaptadores. Pode orientar contribuidores e agentes a implementar no formato errado.
- **Evidência:** `CONTRACT.md:3`; `CONTRACT.md:8`; `CONTRACT.md:38`; `package.json:58`.
- **Correção proposta:** Atualizar contrato executável e remover/arquivar regras históricas; manter tipos/eventos/capacidades como fonte de referência.

### A57 — CI/release deixa de executar a suíte de permissões

- **Problema e impacto:** npm test usa lista manual que exclui config-permissions.test.mjs e outras suítes; CI e release usam essa lista. Mudanças no teto/default podem passar sem os checks já existentes.
- **Evidência:** `package.json:63`; `.github/workflows/ci.yml:28`; `.github/workflows/release.yml:48`; `acceptance/config-permissions.test.mjs:31`.
- **Correção proposta:** Separar suítes locais das integrações com credenciais e descobrir automaticamente as primeiras; incluir checks de permissões e transporte no gate adequado.

### A58 — Timeout do app-server não cobre handshake nem RPCs pendentes

- **Problema e impacto:** ensureStarted vem antes do timer/abort handler; sendRpc não tem prazo. Mesmo depois de iniciar timer, falhar queue não resolve o await de thread/start ou turn/start. App-server sem resposta pode prender chamada além do timeout.
- **Evidência:** `src/adapters/codex-daemon.ts:131`; `src/adapters/codex-daemon.ts:165`; `src/adapters/codex-daemon.ts:317`; `src/adapters/codex-daemon.ts:373`.
- **Correção proposta:** Aplicar deadline/signal à inicialização e a cada RPC pendente; rejeitar e limpar pendingRequests com término controlado.

### A59 — Transporte app-server ignora opções aceitas pela API

- **Problema e impacto:** Daemon inicia apenas codex app-server sem extraArgs/MCP injected do bridge; entrada do turno inclui somente texto, sem images. offline/isolated não são aplicados. Em continue/fork, modelo e sandbox pedidos não são reaplicados ao turno. A chamada aceita essas opções sem erro.
- **Evidência:** `src/adapters/codex.ts:168`; `src/adapters/codex-daemon.ts:386`; `src/adapters/codex-daemon.ts:400`.
- **Correção proposta:** Implementar paridade por capacidade ou rejeitar opções incompatíveis antes de executar; aplicar modelo/sandbox/política em todo turno.

### A60 — Saída prematura do streaming não fecha o adaptador interno

- **Problema e impacto:** Loops manuais de next/yield não chamam it.return em finally. Consumidor que encerra run/runTracked/runWithTelemetry deixa gerador interno pausado; finalmente do adaptador não mata o subprocesso. Tracker pode marcar cancelado enquanto processo continua.
- **Evidência:** `src/index.ts:259`; `src/index.ts:276`; `src/telemetry/track.ts:68`; `src/telemetry/track.ts:142`.
- **Correção proposta:** Propagar return/throw ao iterador interno e sinalizar abort na saída antecipada; aguardar cleanup.

### A61 — Adaptadores novos reportam timeout e cancelamento como execução normal

- **Problema e impacto:** Após wait, esses adaptadores não inspecionam aborted/timedOut. Se há texto parcial, retornam timedOut false; sem texto usam erro genérico. Erros normalizados e fallback ficam inconsistentes.
- **Evidência:** `src/adapters/acp.ts:104`; `src/adapters/cursor.ts:68`; `src/adapters/devin.ts:65`; `src/adapters/grok.ts:64`; `src/adapters/gemini.ts:73`.
- **Correção proposta:** Tratar ProcessWaitResult antes de interpretar sucesso; lançar ABORTED/TIMEOUT com resultado parcial e flags corretos.

### A62 — Validação e retomada de sessões consultam perfil diferente da execução

- **Problema e impacto:** rolloutExists/newestRollout e latestSession usam process.env; OpenCode hasAuth/redator consultam perfil padrão antes de montar o.env. Run com conta selecionada pode rejeitar sessão/login válido ou escolher sessão/credencial do perfil errado.
- **Evidência:** `src/adapters/codex.ts:14`; `src/adapters/codex.ts:125`; `src/adapters/claude.ts:37`; `src/adapters/opencode.ts:20`; `src/adapters/opencode.ts:454`.
- **Correção proposta:** Resolver ambiente de conta uma vez e passá-lo a autenticação, listagem, retomada, redator e spawn.

### A63 — Endpoint pode usar nome de adaptador reservado e nunca ser executado

- **Problema e impacto:** Endpoint reserva só os cinco agentes antigos; cursor/grok/gemini/devin/acp são aceitos como endpoint, mas registry resolve primeiro para built-in. A lista MCP ainda pode conter nomes duplicados.
- **Evidência:** `src/adapters/endpoint.ts:13`; `src/adapters/endpoint.ts:96`; `src/index.ts:25`; `src/index.ts:41`; `src/bridge/mcp.ts:27`.
- **Correção proposta:** Usar catálogo único de nomes reservados e deduplicar tools; recusar conflito no cadastro e na carga.

### A64 — Roster perde nomes MCP completos e conclui dispatch antes da tarefa terminar

- **Problema e impacto:** consumeEvent só aceita startsWith ask_/dispatch_ antes de remover prefixo MCP. Nomes mcp__agentbridge__ask_* ficam invisíveis. Output de dispatch com runId marca completed embora tarefa continue; não há atualização vinculada a wait_run.
- **Evidência:** `src/bridge/subagent-roster.ts:344`; `src/bridge/subagent-roster.ts:380`; `src/bridge/subagent-roster.ts:402`.
- **Correção proposta:** Normalizar nome antes do filtro e acompanhar runId até estado terminal; distinguir conclusão da ferramenta de conclusão da tarefa.

### A65 — Proxy retoma sessão de fallback no adaptador original

- **Problema e impacto:** Proxy grava sessionId do resultado de fallback sob chave do agente original e omite r.fallback do retorno. Próxima chamada com x-ab-session tenta retomar esse ID no agente errado; estatísticas atribuem resposta/modelo à origem.
- **Evidência:** `src/server/common.ts:345`; `src/server/common.ts:541`; `src/server/common.ts:562`.
- **Correção proposta:** Persistir agente efetivo na chave e continuar pela mesma identidade; propagar metadados de fallback ao cliente e métricas.

### A66 — Responses aceita previous_response_id sem recuperar contexto

- **Problema e impacto:** Endpoint só converte input; previous_response_id não é lido, validado ou avisado. Cliente que continua uma conversa por esse campo recebe resposta sem histórico anterior.
- **Evidência:** `src/server/openai.ts:246`; `src/server/openai.ts:282`; `docs/PROXY.md:204`.
- **Correção proposta:** Implementar vínculo com sessão/histórico ou rejeitar parâmetro explicitamente como não suportado.

### A67 — Limites de saída inválidos são removidos em vez de rejeitados

- **Problema e impacto:** Chat/Responses convertem limite zero, negativo, string ou fracionário em undefined. Chamada segue sem limite; Anthropic tem validação diferente. Limite implementado também é maxTokens*4 caracteres, não contagem real de tokens.
- **Evidência:** `src/server/common.ts:199`; `src/server/openai.ts:98`; `src/server/anthropic.ts:109`.
- **Correção proposta:** Validar campos por protocolo com erro 400 e documentar estimativa; usar tokenizador/limite nativo quando disponível.

### A68 — App-server pode reportar sucesso quando o daemon encerra inesperadamente

- **Problema e impacto:** listenBackground finally fecha queue e resolve conclusão quando stdout termina sem erro; runTurn então retorna exitCode 0/timedOut false. turn/completed também não verifica status/error do turno. Encerramento normal do pipe ou turno falho pode parecer resposta bem-sucedida.
- **Evidência:** `src/adapters/codex-daemon.ts:211`; `src/adapters/codex-daemon.ts:293`; `src/adapters/codex-daemon.ts:418`.
- **Correção proposta:** Propagar falha do processo e status terminal do turno; só retornar sucesso após confirmação correspondente de conclusão válida.

### A69 — Tools MCP dos agentes novos falham na montagem do MCP filho

- **Problema e impacto:** Bridge anuncia ask/dispatch para cursor/grok/gemini/devin/acp, mas execute chama mcpConfigFor(agent), que só aceita claude/codex/opencode/agy/pi. As chamadas aos novos built-ins falham com Unknown caller agent antes da execução.
- **Evidência:** `src/bridge/mcp.ts:26`; `src/bridge/mcp.ts:535`; `src/bridge/attach.ts:110`.
- **Correção proposta:** Ampliar integração por capacidades reais ou executar adaptadores sem injeção quando ela não é suportada; não anunciar ferramenta inexequível.

### A70 — Sessões e opções são aceitas mas ignoradas nos adaptadores novos

- **Problema e impacto:** Esses adaptadores validam RunOptions mas não usam session/effort/images/jsonSchema/mcpServers e outros campos. continue/fork inicia execução sem recuperar sessão; ephemeral não garante ausência de persistência. systemPrompt também é ignorado em alguns deles.
- **Evidência:** `src/adapters/cursor.ts:18`; `src/adapters/gemini.ts:24`; `src/adapters/devin.ts:17`; `src/adapters/grok.ts:18`; `CONTRACT.md:28`.
- **Correção proposta:** Declarar capacidades por agente e recusar opções não suportadas; implementar sessões com isolamento e identidade explícitos antes de oferecer paridade.

## P3 — Simplificar arquitetura e apresentação

### A71 — Camadas centrais dependem de CLI e têm registros duplicados

- **Problema e impacto:** core/config depende de bridge/runs para home; memória inclui parser e handler CLI; listas de agentes divergem entre registry, endpoint e readiness. Isso já gera diferenças de disponibilidade e nomes reservados.
- **Evidência:** `src/core/config.ts:4`; `src/telemetry/memory.ts:9`; `src/index.ts:26`; `src/bridge/mcp.ts:26`; `src/adapters/endpoint.ts:15`; `src/core/readiness.ts:7`.
- **Correção proposta:** Extrair paths/config/storage e catálogo de capacidades para core; mover cmdMemory à CLI e fazer demais superfícies consumirem o catálogo único.

### A72 — Ensemble chama de consenso uma resposta sem concordância

- **Problema e impacto:** Sem juiz, todas respostas diferentes ficam com um voto e a primeira é retornada no campo consensus. Usuário não distingue consenso de desempate arbitrário.
- **Evidência:** `src/extras/consensus.ts:479`.
- **Correção proposta:** Retornar método, votos, concordância e estado sem consenso; exigir juiz ou política explícita para empate.

