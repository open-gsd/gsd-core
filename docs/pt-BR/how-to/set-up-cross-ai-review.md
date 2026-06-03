# Como configurar a revisão entre diferentes IAs

**Objetivo:** Configurar quais revisores de IA participam da revisão de planos, executar uma revisão de uma fase planejada e usar o feedback para convergir para um plano sem preocupações de severidade ALTA.

**Pré-requisitos:** A fase foi planejada (os arquivos `{phase}-PLAN.md` existem em `.planning/phases/`). Pelo menos um CLI de IA externo está instalado e autenticado.

---

## Decidir quais revisores usar

O GSD Core pode encaminhar solicitações de revisão para qualquer combinação de: Gemini CLI, Claude (sessão separada), Codex CLI, CodeRabbit, OpenCode, Qwen Code, Cursor, Antigravity CLI, Ollama, LM Studio e llama.cpp.

Cada revisor executa o mesmo prompt estruturado contra seus arquivos `PLAN.md` de forma independente. Como diferentes modelos têm diferentes pontos cegos, o consenso de múltiplos revisores detecta mais problemas do que qualquer revisor individual.

**Se você ainda não tem CLIs externos instalados**, instale pelo menos um:

```bash
# Gemini CLI (gratuito com credenciais Google)
npm install -g @google/gemini-cli

# Antigravity CLI (gratuito com credenciais Google)
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## Definir revisores padrão (opcional)

Por padrão, `/gsd-review` executa todos os CLIs detectados. Para fixar um subconjunto como padrões do projeto:

```bash
/gsd-config --integrations
```

O assistente de integrações cobre chaves de API, roteamento de CLIs para revisão de código e a lista `review.default_reviewers`. Defina a lista com os revisores que você deseja como padrão sem flags — por exemplo `["gemini","codex"]`.

Como alternativa, defina diretamente com `gsd-tools`:

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

Para o esquema completo de configurações de integração (chaves de API, substituições de modelo por revisor, endereços de servidor local), consulte [Configuração](../CONFIGURATION.md).

---

## Executar uma revisão

### Revisão padrão (usa seus padrões configurados ou todos os CLIs detectados)

```bash
/gsd-review --phase 3
```

O GSD invoca cada revisor em sequência, coleta feedback estruturado (Resumo, Pontos Fortes, Preocupações em ALTA/MÉDIA/BAIXA, Sugestões, Avaliação de Risco) e grava a saída combinada em `.planning/phases/03-.../03-REVIEWS.md`.

### Selecionar um único revisor para uma execução pontual

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

Qualquer flag explícita substitui tanto o padrão `--all` quanto `review.default_reviewers` para aquela execução.

### Executar todos os revisores disponíveis em paralelo

```bash
/gsd-review --phase 3 --all
```

`--all` sempre substitui a configuração e executa o conjunto completo detectado, incluindo quaisquer servidores de modelos locais configurados (Ollama, LM Studio, llama.cpp).

### Revisores com servidor de modelo local

Se você executa Ollama ou LM Studio localmente, eles são incluídos automaticamente com `--all` quando o servidor está acessível. Você também pode direcioná-los explicitamente:

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

Configure os endereços de host e a seleção de modelo nas chaves `review.*` via `/gsd-config --integrations` se os padrões (`localhost:11434` / `localhost:1234`) não se aplicarem.

---

## Ler a saída da revisão

O arquivo `{padded_phase}-REVIEWS.md` contém:

- Revisões individuais de cada revisor com preocupações classificadas por severidade
- Uma seção de **Resumo de Consenso** que sintetiza preocupações levantadas por dois ou mais revisores — comece aqui para obter o sinal de maior prioridade
- Uma seção de **Visões Divergentes** para áreas onde os revisores discordaram

---

## Incorporar o feedback ao plano

Após revisar a saída, replaneje incorporando o feedback:

```bash
/gsd-plan-phase 3 --reviews
```

O planejador lê `REVIEWS.md` e ajusta os planos para endereçar as preocupações antes de salvar.

---

## Automatizar o ciclo planejar–revisar–replanejar

Para fases em que você deseja iterar até que todas as preocupações de severidade ALTA sejam resolvidas, use o ciclo de convergência:

```bash
/gsd-plan-review-convergence 3
```

Isso executa `plan-phase → review → replan → re-review` por até três ciclos (padrão). O ciclo termina quando a contagem de preocupações ALTAS chega a zero.

### Convergência com um revisor específico

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### Convergência com todos os revisores e um limite maior de ciclos

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**Detecção de estagnação:** se a contagem de preocupações ALTAS não estiver diminuindo entre os ciclos, o GSD avisa você. Quando o limite de ciclos é atingido com preocupações ALTAS em aberto, um portão de escalação pergunta se você deseja prosseguir ou revisar manualmente.

---

## Condicionais: quais revisores escolher

| Situação | Abordagem recomendada |
|-----------|---------------------|
| Você já tem o Gemini CLI instalado | `--gemini` é sempre um bom revisor inicial |
| Você quer cobertura gratuita com múltiplos revisores | `--gemini` + `--agy` (ambos usam credenciais Google) |
| Seu projeto é fortemente baseado em OpenAI | adicione `--codex` para uma perspectiva de modelo OpenAI |
| Você quer o modelo do GitHub Copilot | adicione `--opencode` |
| Você quer evitar custos de API completamente | configure o Ollama com um modelo local e use `--ollama` |
| Você precisa de cobertura máxima antes de um lançamento | `/gsd-plan-review-convergence N --all` |
| Você está iterando rapidamente e quer feedback rápido | escolha um CLI: `/gsd-review --phase N --gemini` |

---

## Relacionados

- [Verificar e publicar](verify-and-ship.md)
- [Configuração](../CONFIGURATION.md)
- [Comandos](../COMMANDS.md)
- [Índice da documentação](../README.md)
