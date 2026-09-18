import i18n from '@/lib/i18n'
import { useIsMobile } from '@/lib/useIsMobile'
import { undoDepth, redoDepth, redo, undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { Code2, Eye } from 'lucide-react'
import {
  ClipboardEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import VisualMarkdownEditor, {
  type VisualMarkdownEditorRef,
} from './VisualMarkdownEditor'
import MarkdownCodeEditor from './MarkdownCodeEditor'
import MarkdownToolbar from './MarkdownToolbar'
import {
  insertHeadingAtStart,
  insertWrappedText,
  replaceFilenameInText,
} from './editorCommands'

import { uploadAsset, UploadAssetResponse } from '@/lib/api/assets'
import { mapApiError } from '@/lib/api/errors'
import { formatBytes, IMAGE_EXTENSIONS } from '@/lib/config'
import { useConfigStore } from '@/stores/config'
import { useEditorStore } from '@/stores/editor'
import { toast } from 'sonner'
import { htmlToMarkdown } from './htmlToMarkdown'
import { uploadInlineDataUriImages } from './pasteImageUpload'

export type MarkdownEditorRef = {
  insertAtCursor: (text: string) => void
  getSelectedText?: () => string
  getMarkdown: () => string
  insertWrappedText: (before: string, after?: string) => void
  insertHeading: (level: 1 | 2 | 3) => void
  replaceSelection: (text: string) => void
  replaceFilenameInMarkdown?: (before: string, after: string) => void
  editorViewRef: React.RefObject<EditorView | null>
  focus: () => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  pasteRich: () => Promise<void>
  pastePlain: () => Promise<void>
}

type Props = {
  initialValue?: string
  onChange: (newValue: string) => void
  pageId: string
}

const MarkdownEditor = (
  { initialValue = '', onChange, pageId }: Props,
  ref: React.ForwardedRef<MarkdownEditorRef>,
) => {
  const { t } = useTranslation('editor', { i18n })
  const editorViewRef = useRef<EditorView | null>(null)
  const visualRef = useRef<VisualMarkdownEditorRef | null>(null)
  const activePane = useRef<'visual' | 'raw'>('visual')
  const sourceComposing = useRef(false)
  const [markdown, setMarkdown] = useState(initialValue)
  const markdownRef = useRef(initialValue)
  const isMobile = useIsMobile()
  const [activeTab, setActiveTab] = useState<'visual' | 'raw'>('visual')
  const maxAssetUploadSizeBytes = useConfigStore(
    (s) => s.maxAssetUploadSizeBytes,
  )
  const { lineWrap } = useEditorStore()

  const publish = useCallback(
    (value: string) => {
      if (markdownRef.current === value) return
      markdownRef.current = value
      setMarkdown(value)
      onChange(value)
    },
    [onChange],
  )

  // Handles paste requests.
  // This allows to paste images from clipboard directly into the editor.
  const handlePaste = useCallback(
    async (event: ClipboardEvent<HTMLDivElement>) => {
      const { clipboardData } = event
      if (!clipboardData) return

      const files: File[] = []

      if (clipboardData.files && clipboardData.files.length > 0) {
        files.push(...Array.from(clipboardData.files))
      } else if (clipboardData.items && clipboardData.items.length > 0) {
        Array.from(clipboardData.items).forEach((item) => {
          if (item.kind === 'file') {
            const file = item.getAsFile()
            if (file) {
              files.push(file)
            }
          }
        })
      }

      if (files.length === 0) {
        return
      }

      // We take over the paste event to handle image files
      event.preventDefault()
      event.stopPropagation()

      const targetPane = activePane.current
      const startView = editorViewRef.current

      // Process each file
      for (const file of files) {
        if (file.size > maxAssetUploadSizeBytes) {
          toast.error(
            t('markdownEditor.fileTooLarge', {
              maxSize: formatBytes(maxAssetUploadSizeBytes),
            }),
          )
          continue
        }

        // Upload each file
        try {
          const res: UploadAssetResponse = await uploadAsset(pageId, file)

          toast.success(
            t('markdownEditor.uploadedToast', { filename: file.name }),
          )

          // The result of uploadAsset looks like this:
          // {"file":"/assets/0NmpvSivg/preview-scrollbar.gif"}
          const uploadedFile = res.file
          const ext = file.name.split('.').pop()?.toLowerCase()

          const isImage =
            file.type.startsWith('image/') ||
            IMAGE_EXTENSIONS.includes(ext ?? '')

          const markdown = isImage
            ? `![${file.name}](${uploadedFile})\n`
            : `[${file.name}](${uploadedFile})\n`

          if (editorViewRef.current !== startView) continue
          if (targetPane === 'visual') {
            visualRef.current?.insert(markdown)
            continue
          }
          const view = editorViewRef.current
          if (!view) continue
          const { from } = view.state.selection.main
          view.dispatch({
            changes: { from, insert: markdown },
            selection: { anchor: from + markdown.length },
          })

          const newDoc = view.state.doc.toString()
          publish(newDoc)
          editorViewRef.current?.focus()
        } catch (err) {
          console.error('Upload failed', err)
          toast.error(
            mapApiError(
              err,
              t('markdownEditor.uploadErrorFallback', { filename: file.name }),
            ).message,
          )
        }
      }
    },
    [maxAssetUploadSizeBytes, pageId, publish, t],
  )

  useEffect(() => {
    markdownRef.current = initialValue
    setMarkdown(initialValue)
  }, [initialValue, pageId])

  // Rich paste (HTML → Markdown) is only reachable via Ctrl/Cmd+Shift+V and the
  // toolbar/dropdown buttons for now — plain Ctrl/Cmd+V stays default browser
  // paste while rich paste is being tested. See MarkdownCodeEditor's
  // Shift-Mod-v keymap, which calls this same callback.
  const pasteRich = useCallback(async () => {
    const startView = editorViewRef.current
    const targetPane = activePane.current
    if (!startView) return
    let md: string | null = null
    try {
      if (typeof navigator.clipboard.read === 'function') {
        const items = await navigator.clipboard.read()
        for (const item of items) {
          if (item.types.includes('text/html')) {
            const blob = await item.getType('text/html')
            md = htmlToMarkdown(await blob.text()) || null
            break
          }
        }
        // Reuse the same clipboard read for the plain-text fallback instead
        // of issuing a second navigator.clipboard call, which can trigger a
        // second permission prompt for the same paste action.
        if (!md) {
          for (const item of items) {
            if (item.types.includes('text/plain')) {
              const blob = await item.getType('text/plain')
              md = (await blob.text()) || null
              break
            }
          }
        }
      }
    } catch {
      // clipboard-read permission denied or API unavailable — fall through to readText
    }
    if (!md) {
      try {
        md = (await navigator.clipboard.readText()) || null
      } catch {
        toast.error(t('toolbar.pasteClipboardError'))
        return
      }
    }
    if (!md) return
    md = await uploadInlineDataUriImages(md, pageId, maxAssetUploadSizeBytes)
    // Re-read after awaits: the editor may have been destroyed, or replaced
    // by a different page's editor (navigation during the async clipboard
    // read), while this was pending — only proceed if it's still the same
    // live view the paste was initiated on.
    const view = editorViewRef.current
    if (!view || view !== startView) return
    if (targetPane === 'visual') {
      visualRef.current?.insert(md)
      return
    }
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: md },
      selection: { anchor: sel.from + md.length },
    })
    const newDoc = view.state.doc.toString()
    publish(newDoc)
    view.focus()
  }, [maxAssetUploadSizeBytes, publish, pageId, t])

  const pastePlain = useCallback(async () => {
    const startView = editorViewRef.current
    const targetPane = activePane.current
    if (!startView) return
    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      toast.error(t('toolbar.pasteClipboardError'))
      return
    }
    if (!text) return
    // Re-read after await: the editor may have been destroyed, or replaced
    // by a different page's editor (navigation during the async clipboard
    // read), while this was pending — only proceed if it's still the same
    // live view the paste was initiated on.
    const view = editorViewRef.current
    if (!view || view !== startView) return
    if (targetPane === 'visual') {
      visualRef.current?.insertPlain(text)
      return
    }
    const sel = view.state.selection.main
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    })
    const newDoc = view.state.doc.toString()
    publish(newDoc)
    view.focus()
  }, [publish, t])

  useImperativeHandle(ref, () => ({
    insertAtCursor: (text: string) => {
      if (activePane.current === 'visual')
        return visualRef.current?.insert(text)
      const view = editorViewRef.current
      if (!view) return
      const { from } = view.state.selection.main
      view.dispatch({
        changes: { from, insert: text },
        selection: { anchor: from + text.length },
      })
      const newDoc = view.state.doc.toString()
      publish(newDoc)
      editorViewRef.current?.focus()
    },
    insertWrappedText: (before: string, after = before) => {
      if (activePane.current === 'visual')
        return visualRef.current?.wrap(before, after)
      const view = editorViewRef.current
      if (!view) return
      insertWrappedText(view, before, after)
      const newDoc = view.state.doc.toString()
      publish(newDoc)
      editorViewRef.current?.focus()
    },
    replaceSelection: (text: string) => {
      if (activePane.current === 'visual')
        return visualRef.current?.insert(text)
      const view = editorViewRef.current
      if (!view) return
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      })
      const newDoc = view.state.doc.toString()
      publish(newDoc)
      editorViewRef.current?.focus()
    },
    insertHeading: (level: 1 | 2 | 3) => {
      if (activePane.current === 'visual')
        return visualRef.current?.heading(level)
      const view = editorViewRef.current
      if (!view) return
      insertHeadingAtStart(view, level)
      const newDoc = view.state.doc.toString()
      publish(newDoc)
      editorViewRef.current?.focus()
    },
    replaceFilenameInMarkdown: (before: string, after: string) => {
      const view = editorViewRef.current
      if (!view) return
      const docText = view.state.doc.toString()

      const updatedText = replaceFilenameInText(docText, before, after)

      // Replace the entire document content
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: updatedText },
      })

      publish(updatedText)
    },
    editorViewRef: editorViewRef,
    getMarkdown: () => markdownRef.current,
    getSelectedText: () => {
      if (activePane.current === 'visual')
        return visualRef.current?.selectedText() ?? ''
      const view = editorViewRef.current
      return (
        view?.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to,
        ) ?? ''
      )
    },
    focus: () =>
      activePane.current === 'visual'
        ? visualRef.current?.focus()
        : editorViewRef.current?.focus(),
    canUndo: () => {
      if (activePane.current === 'visual')
        return visualRef.current?.canUndo() ?? false
      const view = editorViewRef.current
      if (!view) return false
      return undoDepth(view.state) > 0
    },
    canRedo: () => {
      if (activePane.current === 'visual')
        return visualRef.current?.canRedo() ?? false
      const view = editorViewRef.current
      if (!view) return false
      return redoDepth(view.state) > 0
    },
    undo: () => {
      if (activePane.current === 'visual') return visualRef.current?.undo()
      const view = editorViewRef.current
      if (view) {
        undo(view)
      }
    },
    redo: () => {
      if (activePane.current === 'visual') return visualRef.current?.redo()
      const view = editorViewRef.current
      if (view) {
        redo(view)
      }
    },
    pasteRich,
    pastePlain,
  }))

  return (
    <div className="markdown-editor" onPasteCapture={handlePaste}>
      <MarkdownToolbar
        editorRef={ref as React.RefObject<MarkdownEditorRef>}
        pageId={pageId}
      />
      {isMobile && (
        <div className="markdown-editor__tabs" role="tablist">
          {(['visual', 'raw'] as const).map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`markdown-${tab}-pane`}
              onClick={() => {
                activePane.current = tab
                setActiveTab(tab)
              }}
              className={`markdown-editor__tab-button markdown-editor__tab-button--${activeTab === tab ? 'active' : 'inactive'}`}
            >
              {tab === 'visual' ? <Eye size={16} /> : <Code2 size={16} />}
              {tab === 'visual' ? 'Visual editor' : 'Raw Markdown'}
            </button>
          ))}
        </div>
      )}
      <div className="markdown-editor__dual">
        <section
          id="markdown-visual-pane"
          aria-label="Visual editor"
          className="markdown-editor__dual-pane"
          hidden={isMobile && activeTab !== 'visual'}
          onFocusCapture={() => {
            activePane.current = 'visual'
          }}
        >
          <h2 className="markdown-editor__pane-label">Visual editor</h2>
          <div className="markdown-editor__visual-scroll custom-scrollbar">
            <VisualMarkdownEditor
              ref={visualRef}
              markdown={markdown}
              pageId={pageId}
              onChange={publish}
              sourceComposing={sourceComposing}
            />
          </div>
        </section>
        <section
          id="markdown-raw-pane"
          aria-label="Raw Markdown"
          className="markdown-editor__dual-pane"
          hidden={isMobile && activeTab !== 'raw'}
          onFocusCapture={() => {
            activePane.current = 'raw'
          }}
          onCompositionStart={() => {
            sourceComposing.current = true
          }}
          onCompositionEnd={() => {
            sourceComposing.current = false
          }}
        >
          <h2 className="markdown-editor__pane-label">Raw Markdown</h2>
          <div className="markdown-editor__raw-scroll">
            <MarkdownCodeEditor
              initialValue={markdown}
              resetKey={pageId}
              onChange={publish}
              editorViewRef={editorViewRef}
              lineWrap={lineWrap}
              onPasteRich={pasteRich}
            />
          </div>
        </section>
      </div>
    </div>
  )
}

export default forwardRef<MarkdownEditorRef, Props>(MarkdownEditor)
