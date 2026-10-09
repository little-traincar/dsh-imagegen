import { ImagegenCard } from './ImagegenCard.js'
import { GenerateImageToolview } from './imagegen-toolview.js'
import { buildSaveOps, modelAliasRows, modelOf, modelOverridePresent, IMAGEGEN_NS } from './imagegen-card-core.js'
import * as copy from './locales.js'

const COPY_NS = 'settings.imagegen'

const dictionaries = { zh: copy.zh, en: copy.en }

const PLUGIN_INJECT = ['slots', 'locale', 'configForms']

export { PLUGIN_INJECT as inject }

export function apply(ctx) {

  const form = ctx.configForms.get(IMAGEGEN_NS)
  const t = ctx.locale.bind(COPY_NS)

  ctx.effect(
    () => ctx.locale.register(COPY_NS, dictionaries),
    'imagegen: card dictionaries',
  )

  const face = () => ({
    hooks: {
      imagegenCard: {
        getSnapshot: () => form.getSnapshot(),
        subscribe: (listener) => form.subscribe(listener),
      },
    },

    save: (ops) => form.mutate(ops),

    discard: () => {},
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: IMAGEGEN_NS,
    order: 60,
    label: () => t('title'),
    locale: COPY_NS,
    inject: face,
  }, ImagegenCard))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'generate_image',
    locale: COPY_NS,
  }, GenerateImageToolview))
}

export { buildSaveOps, modelAliasRows, modelOf, modelOverridePresent }
