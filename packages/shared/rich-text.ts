import { getSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { safeHttps, imageAllowed } from './validation.js'

export const documentField = 'default'

export function richTextExtensions(hosts: readonly string[]) {
  const SafeImage = Image.extend({
    renderHTML({ node }) {
      const source =
        typeof node.attrs.src === 'string' && imageAllowed(node.attrs.src, hosts)
          ? node.attrs.src
          : undefined
      return [
        'img',
        {
          src: source,
          alt: String(node.attrs.alt ?? 'External image'),
          loading: 'lazy',
          referrerpolicy: 'no-referrer',
          draggable: 'false',
        },
      ]
    },
  })
  return [
    StarterKit.configure({
      undoRedo: false,
      link: {
        openOnClick: false,
        autolink: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        isAllowedUri: (url) => !!safeHttps(url),
      },
    }),
    TableKit.configure({ table: { resizable: false } }),
    SafeImage.configure({ allowBase64: false }),
  ]
}

export const reportSchema = getSchema(richTextExtensions([]))

export function starterDocument(headings: string[]): JSONContent {
  return {
    type: 'doc',
    content: headings.length
      ? headings.flatMap((heading) => [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
          { type: 'paragraph' },
        ])
      : [{ type: 'paragraph' }],
  }
}
