# Como verificar e publicar uma fase

**Objetivo:** Conduzir o trabalho executado pelo processo de testes de aceitação do usuário, diagnosticar e corrigir eventuais falhas e, em seguida, abrir um pull request com o corpo gerado automaticamente.

**Pré-requisitos:** A fase deve ter sido executada e possuir arquivos `SUMMARY.md`. Se a execução ainda não foi concluída, consulte [Executar uma fase](execute-a-phase.md).

---

## Executar os testes de aceitação do usuário

```bash
/gsd-verify-work 1
```

O GSD lê os arquivos `SUMMARY.md` da fase, extrai as entregas observáveis pelo usuário e guia você por elas uma de cada vez. Para cada ponto de verificação, ele apresenta o que *deveria* acontecer e pergunta se a realidade corresponde.

- `yes` / `y` / vazio → aprovado, avança para o próximo teste
- Qualquer outra coisa → registrado como um problema; a severidade é inferida a partir da sua descrição

Você nunca precisa categorizar a severidade — o GSD a infere a partir das suas palavras ("trava" → bloqueador, "não funciona" → grave, "está estranho" → cosmético).

O progresso é gravado em `.planning/phases/01-<name>/01-UAT.md` e sobrevive a um `/clear`. Se uma sessão for interrompida, execute novamente `/gsd-verify-work 1` e o GSD oferece a opção de retomar a partir do último ponto de verificação.

---

## Quando falhas são encontradas: diagnóstico automático e planejamento de correção

Se algum teste reportar problemas, o GSD prossegue automaticamente:

1. **Diagnostica as causas raiz** — cria agentes de depuração paralelos, um por problema, e atualiza o `UAT.md` com as causas raiz.
2. **Planeja o fechamento das lacunas** — cria um `gsd-planner` no modo de fechamento de lacunas, que lê o `UAT.md` (com os diagnósticos) e escreve novos arquivos `PLAN.md`.
3. **Verifica os planos de correção** — cria um `gsd-plan-checker` para garantir que os planos são executáveis. Se problemas forem encontrados, o planner e o checker iterarão até três vezes.
4. **Apresenta o próximo passo** — quando os planos passam pelo checker:

```
Plans verified and ready for execution.

`/clear` then `/gsd-execute-phase 1 --gaps-only`
```

Execute o comando sugerido para aplicar as correções e, em seguida, execute novamente `/gsd-verify-work 1` para confirmar que tudo passa.

---

## Quando todos os testes passam: publicar a fase

Quando todos os testes de aceitação passam (ou se esta é a primeira execução e nenhum problema é encontrado), a fase é marcada como concluída em `ROADMAP.md` e `STATE.md` automaticamente.

```bash
/gsd-ship 1
```

O GSD executa verificações de pré-voo (status de verificação, árvore de trabalho limpa, branch, remoto, autenticação da CLI `gh`), envia o branch e cria um PR:

```bash
/gsd-ship 1          # PR pronto para revisão
/gsd-ship 1 --draft  # PR em rascunho — útil quando mais fases virão a seguir
```

O corpo do PR é montado automaticamente a partir dos artefatos de planejamento:

- Objetivo da fase em `ROADMAP.md`
- Resumos por plano dos arquivos `SUMMARY.md` e seus arquivos principais
- Requisitos atendidos (REQ-IDs)
- Status de verificação em `VERIFICATION.md`
- Decisões-chave em `STATE.md`

Não é necessário escrever o corpo manualmente.

---

## Opcional: revisão de código antes ou depois de publicar

`/gsd-ship` não executa uma revisão de código automaticamente, mas você pode incluir uma a qualquer momento:

**Antes da verificação** (identifica problemas antes dos testes de aceitação):

```bash
/gsd-code-review 1          # Revisão padrão
/gsd-code-review 1 --fix    # Revisão com correção automática de achados Críticos + Avisos
```

**Depois que o PR estiver aberto** (para controlar a qualidade antes do merge):

```bash
/gsd-code-review 1 --depth=deep  # Análise entre arquivos incluindo grafos de importação
```

Consulte [Configurar revisão entre IAs](set-up-cross-ai-review.md) para configurar o Gemini, Codex ou outros revisores para revisão de planos mais cedo no ciclo.

---

## Opcional: criar um branch de PR limpo

Se o seu branch contiver commits de `.planning/` que você não quer que os revisores vejam:

```bash
/gsd-pr-branch          # Filtrar contra main
/gsd-pr-branch develop  # Filtrar contra develop
```

`/gsd-pr-branch` cria um novo branch apenas com mudanças de código — commits de artefatos de planejamento são excluídos. Execute antes de `/gsd-ship` se a política de revisão da sua equipe exclui ruído de planejamento.

---

## Encerrando um marco

Se esta foi a última fase do marco, execute a auditoria do marco e arquive-o:

```bash
/gsd-audit-milestone      # Verificar se todos os requisitos foram entregues
/gsd-complete-milestone   # Arquivar, criar tag git
```

`/gsd-complete-milestone` é o próximo passo natural após o merge do PR. Consulte [O ciclo de fases](../explanation/the-phase-loop.md) para entender como a verificação e a publicação se encaixam no ciclo de vida completo do projeto.

---

## Relacionados

- [Executar uma fase](execute-a-phase.md)
- [Configurar revisão entre IAs](set-up-cross-ai-review.md)
- [O ciclo de fases](../explanation/the-phase-loop.md)
- [Comandos](../COMMANDS.md)
