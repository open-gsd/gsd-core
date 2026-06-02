# Monitor de Janela de Contexto

Um hook pós-ferramenta (`PostToolUse` para o Claude Code, `AfterTool` para o Gemini CLI) que avisa o agente quando o uso da janela de contexto está elevado.

## Problema

A barra de status exibe o uso de contexto para o **usuário**, mas o **agente** não tem consciência dos limites de contexto. Quando o contexto está se esgotando, o agente continua trabalhando até atingir o limite — potencialmente no meio de uma tarefa, sem nenhum estado salvo.

## Como Funciona

1. O hook da barra de status grava métricas de contexto em `/tmp/claude-ctx-{session_id}.json`
2. Após cada uso de ferramenta, o monitor de contexto lê essas métricas
3. Quando o contexto restante cai abaixo dos limiares, ele injeta um aviso como `additionalContext`
4. O agente recebe o aviso em sua conversa e pode agir de acordo

## Limiares

| Nível | Restante | Comportamento do Agente |
|-------|----------|-------------------------|
| Normal | > 35% | Sem aviso |
| ALERTA | <= 35% | Encerrar a tarefa atual, evitar iniciar trabalhos complexos novos |
| CRÍTICO | <= 25% | Parar imediatamente, salvar estado (`/gsd-pause-work`) |

## Debounce

Para evitar sobrecarregar o agente com avisos repetidos:
- O primeiro aviso sempre é disparado imediatamente
- Avisos subsequentes exigem 5 usos de ferramenta entre eles
- A escalada de severidade (ALERTA -> CRÍTICO) ignora o debounce

## Arquitetura

```
Hook da Barra de Status (gsd-statusline.js)
    | escreve
    v
/tmp/claude-ctx-{session_id}.json
    ^ lê
    |
Monitor de Contexto (gsd-context-monitor.js, PostToolUse/AfterTool)
    | injeta
    v
additionalContext -> Agente recebe o aviso
```

O arquivo de ponte é um objeto JSON simples:

```json
{
  "session_id": "abc123",
  "remaining_percentage": 28.5,
  "used_pct": 71,
  "timestamp": 1708200000
}
```

## Integração com o GSD

O comando `/gsd-pause-work` do GSD salva o estado de execução. A mensagem de ALERTA sugere utilizá-lo. A mensagem CRÍTICA instrui o salvamento imediato do estado.

## Configuração

Ambos os hooks são registrados automaticamente durante a instalação do `npx @opengsd/gsd-core` — nenhuma etapa manual é necessária em circunstâncias normais. Para detalhes de configuração de hooks, substituições de limiares e exemplos de registro manual, consulte [Configuração](CONFIGURATION.md).

Como referência rápida: o hook da barra de status se registra como `statusLine` em `settings.json`; o monitor de contexto (`gsd-context-monitor.js`) se registra como um hook `PostToolUse` (ou `AfterTool` para o Gemini CLI). Ambas as entradas utilizam o caminho absoluto do executável Node que executou o instalador. No Windows PowerShell, prefixe caminhos de executáveis entre aspas com `&`.

## Segurança

- O hook envolve tudo em try/catch e encerra silenciosamente em caso de erro
- Ele nunca bloqueia a execução de ferramentas — um monitor com falha não deve interromper o fluxo de trabalho do agente
- Métricas obsoletas (com mais de 60s) são ignoradas
- Arquivos de ponte ausentes são tratados de forma elegante (subagentes, sessões novas)

---

## Relacionados

- [Arquitetura](ARCHITECTURE.md)
- [Configuração](CONFIGURATION.md)
- [Índice da documentação](README.md)
