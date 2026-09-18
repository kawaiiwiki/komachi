import i18n from '@/lib/i18n'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { undo, redo, undoDepth, redoDepth } from '@milkdown/kit/prose/history'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import { callCommand, insert } from '@milkdown/kit/utils'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { uploadAsset } from '@/lib/api/assets'
import { withBasePath } from '@/lib/routePath'
import { useConfigStore } from '@/stores/config'
import { preservedMarkdown, preservedMarkdownNode } from './milkdownSyntax'
import { createVisualEditorBridge } from './visualEditorBridge'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import './visualMarkdownEditor.css'

export interface VisualMarkdownEditorRef {
  insert: (markdown: string) => void
  insertPlain: (text: string) => void
  wrap: (before: string, after: string) => void
  heading: (level: number) => void
  selectedText: () => string
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  focus: () => void
  flush: () => void
}

interface Props {
  markdown: string
  pageId: string
  onChange: (markdown: string) => void
  sourceComposing: React.RefObject<boolean>
}

const VisualMarkdownEditor = forwardRef<VisualMarkdownEditorRef, Props>(
  function VisualMarkdownEditor(
    { markdown, pageId, onChange, sourceComposing },
    ref,
  ) {
    const { t } = useTranslation('editor', { i18n })
    const root = useRef<HTMLDivElement>(null)
    const instance = useRef<Crepe | null>(null)
    const latest = useRef({ markdown, onChange })
    const applied = useRef(markdown)
    const flushRef = useRef<() => void>(() => {})
    const performRef = useRef<(action: (editor: Crepe) => void) => void>(
      () => {},
    )
    const [error, setError] = useState(false)
    useLayoutEffect(() => {
      latest.current = { markdown, onChange }
    })

    // Explicit Crepe lifecycle (the same API used by the official Playground).
    // A private root per creation also isolates React StrictMode's async cleanup.
    useEffect(() => {
      const container = root.current
      if (!container) return
      const host = document.createElement('div')
      container.append(host)
      let disposed = false
      const pending: Array<(editor: Crepe) => void> = []
      let timer: ReturnType<typeof setTimeout> | undefined
      const bridge = createVisualEditorBridge((value) => {
        // A late node-view update must not overwrite a newer Raw document that
        // is still waiting for debounce/composition. Focus flushes before editing.
        if (applied.current !== latest.current.markdown) return
        applied.current = value
        latest.current = { ...latest.current, markdown: value }
        latest.current.onChange(value)
      })
      const crepe = new Crepe({
        root: host,
        defaultValue: latest.current.markdown,
        features: { [Crepe.Feature.Latex]: false, [Crepe.Feature.AI]: false },
        featureConfigs: {
          [Crepe.Feature.ImageBlock]: {
            onUpload: async (file) => {
              const max = useConfigStore.getState().maxAssetUploadSizeBytes
              if (file.size > max)
                throw new Error(
                  t('markdownEditor.fileTooLarge', { maxSize: `${max} B` }),
                )
              return (await uploadAsset(pageId, file)).file
            },
            proxyDomURL: (url) =>
              url.startsWith('/assets/') ? withBasePath(url) : url,
          },
        },
      })
      crepe.editor
        .use(preservedMarkdown)
        .use(preservedMarkdownNode)
        .use(bridge.plugin)
      applied.current = latest.current.markdown
      const flush = () => {
        clearTimeout(timer)
        if (disposed || !instance.current) return
        if (
          sourceComposing.current ||
          crepe.editor.action((ctx) => ctx.get(editorViewCtx).composing)
        ) {
          timer = setTimeout(flush, 50)
          return
        }
        try {
          if (applied.current !== latest.current.markdown) {
            crepe.editor.action((ctx) =>
              bridge.replace(ctx, latest.current.markdown),
            )
            applied.current = latest.current.markdown
          }
          crepe.setReadonly(false)
          setError(false)
          // Async uploads/clipboard reads may finish while Raw is composing.
          // Apply them only after the newest source has reached this view.
          for (const action of pending.splice(0)) action(crepe)
        } catch {
          crepe.setReadonly(true)
          setError(true)
        }
      }
      flushRef.current = flush
      performRef.current = (action) => {
        pending.push(action)
        flush()
      }
      const creating = crepe
        .create()
        .then(() => {
          if (disposed) return
          instance.current = crepe
          bridge.start()
          flush()
        })
        .catch(() => {
          if (!disposed) setError(true)
        })
      return () => {
        disposed = true
        clearTimeout(timer)
        bridge.stop()
        instance.current = null
        flushRef.current = () => {}
        performRef.current = () => {}
        host.remove()
        // Milkdown's destroy during creation does not wait for creation to finish.
        // Await it explicitly to avoid leaking a late-created view after navigation.
        void creating.then(() => crepe.destroy()).catch(console.error)
      }
    }, [pageId, sourceComposing, t])

    useEffect(() => {
      const timer = setTimeout(() => flushRef.current(), 120)
      return () => clearTimeout(timer)
    }, [markdown])

    useImperativeHandle(ref, () => {
      const selectedText = () =>
        instance.current?.editor.action((ctx) => {
          const { doc, selection } = ctx.get(editorViewCtx).state
          return doc.textBetween(selection.from, selection.to, '\n')
        }) ?? ''
      const insertMarkdown = (value: string) => {
        performRef.current((crepe) => {
          crepe.editor.action(insert(value, true))
          crepe.editor.action((ctx) => ctx.get(editorViewCtx).focus())
        })
      }
      return {
        insert: insertMarkdown,
        insertPlain: (text) => {
          performRef.current((crepe) =>
            crepe.editor.action((ctx) => {
              const view = ctx.get(editorViewCtx)
              view.dispatch(view.state.tr.insertText(text))
              view.focus()
            }),
          )
        },
        selectedText,
        wrap: (before, after) => {
          const command =
            before === '**'
              ? toggleStrongCommand
              : before === '_'
                ? toggleEmphasisCommand
                : before === '`'
                  ? toggleInlineCodeCommand
                  : before === '~~'
                    ? toggleStrikethroughCommand
                    : null
          if (command) instance.current?.editor.action(callCommand(command.key))
          else insertMarkdown(`${before}${selectedText()}${after}`)
        },
        heading: (level) => {
          instance.current?.editor.action(
            callCommand(wrapInHeadingCommand.key, level),
          )
        },
        undo: () => {
          instance.current?.editor.action((ctx) => {
            const v = ctx.get(editorViewCtx)
            undo(v.state, v.dispatch)
          })
        },
        redo: () => {
          instance.current?.editor.action((ctx) => {
            const v = ctx.get(editorViewCtx)
            redo(v.state, v.dispatch)
          })
        },
        canUndo: () =>
          Boolean(
            instance.current?.editor.action((ctx) =>
              undoDepth(ctx.get(editorViewCtx).state),
            ),
          ),
        canRedo: () =>
          Boolean(
            instance.current?.editor.action((ctx) =>
              redoDepth(ctx.get(editorViewCtx).state),
            ),
          ),
        focus: () =>
          instance.current?.editor.action((ctx) =>
            ctx.get(editorViewCtx).focus(),
          ),
        flush: () => flushRef.current(),
      }
    }, [])

    return (
      <>
        <p className="visual-editor__notice">
          {t('markdownEditor.protectedSyntax')}
        </p>
        {error && <p role="alert">{t('markdownEditor.visualError')}</p>}
        <div
          className="visual-editor"
          ref={root}
          onFocusCapture={() => flushRef.current()}
          data-testid="visual-editor"
        />
      </>
    )
  },
)

export default VisualMarkdownEditor
