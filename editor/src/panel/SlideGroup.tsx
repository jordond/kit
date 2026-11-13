import { Image as ImageIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { localeText, slideId } from '../../../src/lib/storeshots/resolve'
import { ShotPicker } from '../components/ShotPicker'
import type { LocaleField } from '../scope'
import { useEditor } from '../store'

const INPUT =
  'w-full rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-zinc-100 outline-none placeholder:text-zinc-600 focus-visible:ring-2 focus-visible:ring-sky-500'

function Text({
  label,
  value,
  placeholder,
  multiline,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  multiline?: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1 py-1">
      <label htmlFor={id} className="text-zinc-300">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT} resize-y`}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      )}
    </div>
  )
}

/**
 * The slide's own content: its shot, name and words, and its words in the locale picked in the
 * header. Content is always the slide's, whatever the scope.
 */
export function SlideGroup() {
  const project = useEditor((s) => (s.project?.version === 2 ? s.project : null))
  const index = useEditor((s) => s.activeSlide)
  const locale = useEditor((s) => s.locale)
  const { setSlideContent, setLocaleContent, setSlideShot } = useEditor.getState()
  const [picking, setPicking] = useState(false)
  const slide = project?.slides[index]
  if (!project || !slide) return <p className="py-2 text-zinc-500">No slide selected.</p>

  const id = slideId(slide)
  const own = project.locales?.[locale]?.[id] ?? {}
  const effective = localeText(project, locale, id)
  const localized = (field: LocaleField, base: string | undefined): string => effective[field] ?? base ?? ''

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 py-1">
        <span className="text-zinc-300">Shot</span>
        <code className="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-400">{slide.shot}</code>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-zinc-200 outline-none hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <ImageIcon size={12} aria-hidden /> Change
        </button>
      </div>
      <Text
        label="Name"
        value={slide.name ?? ''}
        placeholder={id}
        onChange={(v) => setSlideContent('name', v)}
      />
      <Text
        label="Headline"
        multiline
        value={slide.headline}
        onChange={(v) => setSlideContent('headline', v)}
      />
      <Text
        label="Subheadline"
        multiline
        value={slide.subheadline ?? ''}
        onChange={(v) => setSlideContent('subheadline', v)}
      />
      <Text label="Badge text" value={slide.badge ?? ''} onChange={(v) => setSlideContent('badge', v)} />

      <fieldset className="mt-2 flex flex-col border-t border-zinc-800 pt-2">
        <legend className="pr-2 text-[11px] text-zinc-400">
          Text in <span className="font-medium text-zinc-200">{locale}</span>
        </legend>
        <p className="text-[10px] text-zinc-500">Leave empty to use the slide text above.</p>
        <Text
          label={`Headline (${locale})`}
          multiline
          value={own.headline ?? ''}
          placeholder={localized('headline', slide.headline)}
          onChange={(v) => setLocaleContent(locale, 'headline', v)}
        />
        <Text
          label={`Subheadline (${locale})`}
          multiline
          value={own.subheadline ?? ''}
          placeholder={localized('subheadline', slide.subheadline)}
          onChange={(v) => setLocaleContent(locale, 'subheadline', v)}
        />
        <Text
          label={`Badge text (${locale})`}
          value={own.badge ?? ''}
          placeholder={localized('badge', slide.badge)}
          onChange={(v) => setLocaleContent(locale, 'badge', v)}
        />
      </fieldset>

      {picking && (
        <ShotPicker
          title="Pick the shot for this slide"
          current={slide.shot}
          onClose={() => setPicking(false)}
          onPick={(file) => {
            setSlideShot(file)
            setPicking(false)
          }}
        />
      )}
    </div>
  )
}
