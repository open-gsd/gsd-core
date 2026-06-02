# Como recuperar e solucionar problemas

**Objetivo:** Identificar e corrigir problemas comuns — desde contexto perdido e estado corrompido até falhas de instalação e erros de permissão — usando uma estrutura de receitas condicionais.

**Pré-requisitos:** GSD Core está instalado. Para problemas específicos de instalação, consulte [Instalar no seu ambiente de execução](install-on-your-runtime.md).

---

## Problemas de contexto e sessão

### Se você perdeu o controle de onde está

```bash
/gsd-progress
```

Lê todos os arquivos de estado e informa exatamente onde você está e o que fazer a seguir.

Para avançar automaticamente para o próximo passo correto:

```bash
/gsd-progress --next
```

### Se você está iniciando uma nova sessão e precisa restaurar o contexto

```bash
/gsd-resume-work
```

Restaura o contexto completo da sua sessão a partir do último handoff, incluindo a fase atual, decisões de planejamento e onde o trabalho foi interrompido.

### Se a qualidade está caindo durante uma sessão longa

Limpe sua janela de contexto entre comandos principais:

```bash
/clear
```

Em seguida, restaure o estado:

```bash
/gsd-resume-work
```

O GSD foi projetado em torno de contextos frescos. Cada subagente já recebe uma janela limpa de 200k. A sessão principal se degrada com o tempo — limpá-la e retomar é o remédio correto, não continuar forçando.

### Se você quer salvar o contexto antes de parar

```bash
/gsd-pause-work
```

Cria `.planning/HANDOFF.json` com sua posição atual. Adicione `--report` para também gravar um resumo pós-sessão em `.planning/reports/`:

```bash
/gsd-pause-work --report
```

---

## Problemas de integridade do planejamento

### Se a integridade de `.planning/` está incerta

```bash
/gsd-health
```

Relata o status entre erros, avisos e notas informativas:

| Status | Significado |
|--------|-------------|
| `HEALTHY` | Todos os artefatos esperados estão presentes e bem formados |
| `DEGRADED` | Avisos que devem ser tratados, mas o trabalho pode continuar |
| `BROKEN` | Erros críticos que bloquearão a execução |

Problemas comuns que podem ser reparados automaticamente (erros E004, E005; avisos W003, W008):

```bash
/gsd-health --repair
```

Isso recria o `STATE.md` ausente, redefine um `config.json` corrompido para os padrões e adiciona quaisquer chaves de configuração ausentes. Não vai sobrescrever `PROJECT.md` ou `ROADMAP.md`.

### Se STATE.md referencia uma fase que não existe

Isso gera o aviso `W002`. Use a CLI de estado para diagnosticar e reparar:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state validate
```

Visualize o que uma sincronização mudaria sem gravar:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync --verify
```

Aplique a sincronização:

```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" state sync
```

Esses comandos reconstroem o `STATE.md` a partir do estado real do projeto em disco. Substituem a edição manual do `STATE.md`.

### Se você vê "Project already initialised"

`.planning/PROJECT.md` já existe. `/gsd-new-project` é uma verificação de segurança. Se você realmente quer começar do zero, delete o diretório `.planning/` primeiro:

```bash
rm -rf .planning/
```

Em seguida, execute novamente `/gsd-new-project`.

### Se a utilização da janela de contexto está alta

```bash
/gsd-health --context
```

Verifica a proteção de utilização da janela de contexto. Emite aviso em 60%, crítico em 70%. Se você estiver acima do limite de aviso, execute `/clear` seguido de `/gsd-resume-work` antes de iniciar o próximo comando principal.

---

## Problemas de execução

### Se um executor recebe "Permission denied" em comandos Bash

Os subagentes `gsd-executor` do GSD precisam de acesso Bash com permissão de escrita. Adicione os padrões necessários em `~/.claude/settings.json` sob `permissions.allow`. No mínimo:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git checkout:*)"
```

Para padrões específicos de stack (Rails, Python, Node, Rust), consulte a tabela completa em `docs/USER-GUIDE.md` em "Executor Subagent Gets Permission denied".

Alternativa por projeto: adicione o mesmo bloco em `.claude/settings.local.json` na raiz do seu projeto.

### Se a execução falha ou produz stubs

Verifique se o plano é ambicioso demais. Os planos devem ter no máximo duas ou três tarefas. Se as tarefas forem muito grandes, elas excedem o que uma única janela de contexto consegue produzir de forma confiável. Replaneje a fase com escopo menor:

```bash
/gsd-plan-phase 1
```

Para diagnóstico sistemático do que deu errado, consulte [Depurar uma execução com falha](debug-a-failed-execution.md).

### Se a execução paralela causa erros de bloqueio de build ou falhas no hook de pré-commit

Isso é causado por múltiplos agentes acionando ferramentas de build simultaneamente. O GSD lida com isso automaticamente desde a v1.26. Se você estiver em uma versão mais antiga, ou ainda vendo contenção, desative a execução paralela:

```bash
/gsd-settings
```

Defina `parallelization.enabled` como `false`.

### Se um subagente parece ter falhado, mas commits foram feitos

Verifique o log do git antes de concluir que algo quebrou:

```bash
git log --oneline -10
```

Um bug de classificação conhecido do Claude Code pode reportar falha enquanto o trabalho foi concluído com sucesso. Os orquestradores do GSD verificam a saída real, mas se você vir uma discrepância, os commits são a fonte da verdade.

---

## Problemas de plano e fase

### Se os planos parecem errados ou desalinhados com sua intenção

Execute `/gsd-discuss-phase N` antes de planejar. A maioria dos problemas de qualidade do plano vem de suposições que o `CONTEXT.md` teria prevenido:

```bash
/gsd-discuss-phase 1
```

Para ver quais suposições o GSD está fazendo atualmente sem iniciar uma sessão completa:

```bash
/gsd-discuss-phase 3 --assumptions
```

### Se você precisa mudar algo após a execução

Não execute novamente `/gsd-execute-phase`. Use `/gsd-quick` para correções direcionadas:

```bash
/gsd-quick "Fix the login button not responding on mobile Safari"
```

Ou use `/gsd-verify-work N` para identificar e corrigir problemas sistematicamente por meio de UAT.

### Se um comando parece congelado em "Spawning…"

Aguarde. Os subagentes do GSD são executados em uma janela de contexto separada. O trabalho deles é invisível para a sessão pai enquanto está em andamento. A nota de atividade na linha de spawn confirma que isso é esperado. Agentes de pesquisa e planejamento rotineiramente levam de 1 a 5 minutos; agentes de verificação podem levar mais tempo em fases grandes.

Não interrompa a sessão. Encerrá-la descarta o trabalho em andamento do subagente.

Se já passou mais de 10 minutos, verifique se a tarefa do agente ainda aparece como ativa na barra lateral do Claude Code.

---

## Problemas de estado do fluxo de trabalho

### Se o fluxo de trabalho parece corrompido ou o estado está inconsistente

```bash
/gsd-forensics
```

Ou com uma descrição:

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

`/gsd-forensics` executa uma investigação post-mortem: anomalias no histórico do git, integridade dos artefatos, consistência do STATE.md, trabalho não commitado e worktrees órfãs. Grava um relatório em `.planning/forensics/` e apresenta etapas de remediação recomendadas. É somente leitura e nunca modifica os arquivos do seu projeto.

### Se você precisa reverter uma fase ou plano

```bash
/gsd-undo --phase 03          # Reverte todos os commits da fase 3
/gsd-undo --plan 03-02        # Reverte os commits do plano 02 da fase 3
/gsd-undo --last 5            # Escolhe interativamente entre os 5 commits GSD mais recentes
```

`/gsd-undo` verifica as fases dependentes antes de reverter e sempre apresenta uma confirmação.

---

## Problemas de instalação e atualização

### Se o GSD não é reconhecido após a instalação

Reinicie seu ambiente de execução. O GSD instala comandos slash no diretório de comandos do seu ambiente de execução (por exemplo, `~/.claude/commands/gsd/`). A maioria dos ambientes de execução descobre novos comandos apenas na inicialização.

Se o problema persistir, verifique a instalação:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

Para caminhos de instalação específicos do ambiente de execução e solução de problemas, consulte [Instalar no seu ambiente de execução](install-on-your-runtime.md).

### Se uma atualização sobrescreveu suas alterações locais

Desde a v1.17, o instalador faz backup dos arquivos modificados localmente em `gsd-local-patches/`. Reaplique suas alterações:

```bash
/gsd-update --reapply
```

### Se você não consegue atualizar via npm

Se `npx @opengsd/gsd-core` falhar devido a interrupções do npm ou restrições de rede, consulte `docs/manual-update.md` para um procedimento de atualização manual passo a passo que funciona sem acesso ao npm.

Para atualizações de rotina, consulte [Atualizar o GSD](update-gsd.md).

---

## Problemas de custo

### Se os custos do modelo estão muito altos

Mude para o perfil de orçamento:

```bash
/gsd-config --profile budget
```

Desative os agentes de pesquisa e verificação de plano via configurações se o domínio for familiar:

```bash
/gsd-settings
```

Audite também quais servidores MCP estão habilitados. Cada servidor MCP habilitado injeta seu esquema de ferramentas em cada turno. Ferramentas específicas de navegador e plataforma podem custar mais de 20k tokens cada. Desabilite os que a fase atual não precisa em `.claude/settings.json`:

```json
{
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

---

## Referência rápida de recuperação

| Problema | Solução |
|----------|---------|
| Contexto perdido ou nova sessão | `/gsd-resume-work` ou `/gsd-progress` |
| Não sabe qual é o próximo passo | `/gsd-progress --next` |
| Fase deu errado | `/gsd-undo --phase NN`, depois replaneje |
| Algo quebrou | `/gsd-debug "descrição"` (adicione `--diagnose` para análise sem correções) |
| STATE.md fora de sincronia | `state validate` depois `state sync` |
| Integridade de `.planning/` incerta | `/gsd-health`, depois `/gsd-health --repair` |
| Estado do fluxo de trabalho parece corrompido | `/gsd-forensics` |
| Correção direcionada rápida | `/gsd-quick` |
| Plano não corresponde à sua visão | `/gsd-discuss-phase N` depois replaneje |
| Custos elevados | `/gsd-config --profile budget` e `/gsd-settings` para desativar agentes |
| Atualização quebrou alterações locais | `/gsd-update --reapply` |
| Quer resumo da sessão | `/gsd-pause-work --report` |
| Erros de build por execução paralela | Atualize o GSD ou defina `parallelization.enabled: false` |

---

## Relacionados

- [Depurar uma execução com falha](debug-a-failed-execution.md)
- [Instalar no seu ambiente de execução](install-on-your-runtime.md)
- [Comandos](../COMMANDS.md)
- [Índice da documentação](../README.md)
