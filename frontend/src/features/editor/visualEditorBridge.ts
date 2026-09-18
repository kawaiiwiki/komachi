import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import type { Ctx } from '@milkdown/kit/ctx'
import { closeHistory } from '@milkdown/kit/prose/history'
import { Selection, Plugin } from '@milkdown/kit/prose/state'
import { $prose } from '@milkdown/kit/utils'

/** A synchronous bridge: saving must never wait for Milkdown's debounced listener.
 * Programmatic replacements do not echo normalized Markdown back to the source.
 */
export function createVisualEditorBridge(onChange: (markdown: string) => void) {
  let applyingSource = false
  let ready = false
  let lastSerialized = ''
  const plugin = $prose(
    (ctx) =>
      new Plugin({
        view: (initialView) => {
          lastSerialized = ctx.get(serializerCtx)(initialView.state.doc)
          return {
            update: (view, previous) => {
              if (view.state.doc.eq(previous.doc)) return
              const markdown = ctx.get(serializerCtx)(view.state.doc)
              const changed = markdown !== lastSerialized
              lastSerialized = markdown
              if (ready && !applyingSource && changed) onChange(markdown)
            },
          }
        },
      }),
  )
  return {
    plugin,
    start: () => {
      ready = true
    },
    stop: () => {
      ready = false
    },
    replace: (ctx: Ctx, markdown: string) => {
      const view = ctx.get(editorViewCtx)
      if (view.composing) return false
      const doc = ctx.get(parserCtx)(markdown)
      if (!doc) throw new Error('Unable to parse Markdown')
      if (view.state.doc.eq(doc)) return true
      applyingSource = true
      try {
        const tr = view.state.tr.replaceWith(
          0,
          view.state.doc.content.size,
          doc.content,
        )
        const anchor = Math.min(
          view.state.selection.anchor,
          tr.doc.content.size,
        )
        tr.setSelection(Selection.near(tr.doc.resolve(anchor)))
        view.dispatch(closeHistory(tr).setMeta('addToHistory', false))
      } finally {
        applyingSource = false
      }
      return true
    },
  }
}
