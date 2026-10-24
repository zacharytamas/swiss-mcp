import { mkdir } from 'node:fs/promises'
import {
  type Attachment,
  ref,
  Shortcut,
  shortcutInput,
  subject,
  type TokenString,
  text,
} from 'shortcutkit'

// Read from Due 26.4.4 (Setapp): Contents/Resources/Metadata.appintents/extract.actionsdata and `codesign -dv`.
const DUE = {
  TeamIdentifier: '5JMF32H3VU',
  BundleIdentifier: 'com.dueapps.duemac-setapp',
  Name: 'Due',
  ActionRequiresAppInstallation: true,
}

type Ref = Attachment<'ActionOutput' | 'ExtensionInput' | 'Variable'>

const s = new Shortcut('swiss-due', {
  color: 'Red',
  inputClasses: [
    'WFStringContentItem',
    'WFDictionaryContentItem',
    'WFGenericFileContentItem',
  ],
})

const aggrandize = (a: Ref, aggrandizement: Record<string, string>): Ref => ({
  ...a,
  Value: {
    ...a.Value,
    Aggrandizements: [
      ...((a.Value.Aggrandizements as ReadonlyArray<Record<string, string>>) ??
        []),
      aggrandizement,
    ],
  },
})
const property = (a: Ref, name: string) =>
  aggrandize(a, {
    Type: 'WFPropertyVariableAggrandizement',
    PropertyName: name,
  })
const asText = (a: Ref) =>
  aggrandize(a, {
    Type: 'WFCoercionVariableAggrandizement',
    CoercionItemClass: 'WFStringContentItem',
  })
const repeatItem: Ref = {
  WFSerializationType: 'WFTextTokenAttachment',
  Value: { Type: 'Variable', VariableName: 'Repeat Item' },
}

const request = s.action('is.workflow.actions.detect.dictionary', {
  WFInput: shortcutInput(),
})
const field = (key: string) =>
  aggrandize(ref(request, 'Dictionary'), {
    Type: 'WFDictionaryValueVariableAggrandizement',
    DictionaryKey: key,
  })

const due = (intent: string, params: Record<string, unknown>) =>
  s.action(`${DUE.BundleIdentifier}.${intent}`, {
    AppIntentDescriptor: { ...DUE, AppIntentIdentifier: intent },
    ShowWhenRun: false,
    ...params,
  } as never)

// Due's reminder Find only honours "Title contains" (measured on Due 26.4.4): no condition, "does not contain",
// "has any value" and date conditions all return nothing. So "every reminder" is "title contains any letter, digit
// or space"; a title made only of other characters (emoji, CJK) is not listed.
const ANY_TITLE = 'abcdefghijklmnopqrstuvwxyz0123456789 '.split('')
const findReminders = (matching?: TokenString) =>
  due('ReminderEntity', {
    WFContentItemFilter: {
      WFSerializationType: 'WFContentPredicateTableTemplate',
      Value: {
        WFActionParameterFilterPrefix: matching ? 1 : 0,
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterTemplates: (matching
          ? [matching]
          : ANY_TITLE.map((c) => text(c))
        ).map((value) => ({
          Property: 'Title',
          Operator: 99,
          Removable: true,
          Values: { Unit: 4, String: value },
        })),
      },
    },
    WFContentItemLimitEnabled: false,
  })

// `otherwise: 'nothing'` stops an unmatched loop item leaking into Repeat Results, since If passes its input through.
const when = (
  value: Ref,
  equals: TokenString,
  body: () => void,
  otherwise?: 'nothing',
) => {
  const gid = crypto.randomUUID().toUpperCase()
  s.action('is.workflow.actions.conditional', {
    GroupingIdentifier: gid,
    WFControlFlowMode: 0,
    // Without a text coercion on the subject, "is" has no type to compare and the run fails with
    // "Please choose a value for each parameter" (measured on macOS 27.0).
    WFInput: subject(asText(value)),
    WFCondition: 4,
    WFConditionalActionString: equals,
  })
  body()
  if (otherwise) {
    s.otherwise(gid)
    s.action('is.workflow.actions.nothing', {})
  }
  s.endIf(gid)
}

const record = (fields: Record<string, TokenString>) =>
  s.action('is.workflow.actions.dictionary', {
    WFItems: {
      WFSerializationType: 'WFDictionaryFieldValue',
      Value: {
        WFDictionaryFieldValueItems: Object.entries(fields).map(
          ([key, value]) => ({
            WFItemType: 0,
            WFKey: text(key),
            WFValue: value,
          }),
        ),
      },
    },
  })

const reminder = (item: Ref) => {
  const due = s.action('is.workflow.actions.format.date', {
    WFDateFormatStyle: 'ISO 8601',
    WFISO8601IncludeTime: true,
    WFDate: text(property(item, 'dueDate')),
  })
  return record({
    title: text(property(item, 'title')),
    dueDate: text(ref(due, 'Formatted Date')),
  })
}

const forEach = (items: Ref, body: () => void) => {
  const gid = s.repeatEach(items)
  body()
  return ref(s.endRepeatEach(gid), 'Repeat Results')
}

// Each op answers with a JSON array: a dictionary coerces to its JSON text, and the items are comma-joined.
const respond = (items: Ref) => {
  const joined = s.action('is.workflow.actions.text.combine', {
    text: items,
    WFTextSeparator: 'Custom',
    WFTextCustomSeparator: ',',
  })
  s.action('is.workflow.actions.output', {
    WFOutput: text('[', ref(joined, 'Combined Text'), ']'),
  })
}

// SWISS_DUE_OPS=reminders.list,timers.stop builds a shortcut with only those ops, for isolating a failing action.
const only = process.env.SWISS_DUE_OPS?.split(',')
const op = (name: string, body: () => void) => {
  if (!only || only.includes(name)) when(field('op'), text(name), body)
}

op('reminders.list', () =>
  respond(
    forEach(ref(findReminders(), 'Reminders'), () => reminder(repeatItem)),
  ),
)

op('reminders.create', () => {
  const created = due('CreateReminderIntent', {
    title: text(field('title')),
    date: text(field('dueDate')),
    parseDateFromTitle: false,
    autosnooze: 'none',
    criticalAlert: 'off',
    syncWhenRun: false,
  })
  respond(ref(reminder(ref(created, 'Reminder')), 'Dictionary'))
})

for (const [name, act] of [
  [
    'reminders.complete',
    (item: Ref) =>
      due('MarkDoneIntent', { reminders: item, syncWhenRun: false }),
  ],
  [
    'reminders.reschedule',
    (item: Ref) =>
      due('EditRemindersIntent', {
        property: 'dueDate',
        reminders: item,
        newDueDate: text(field('dueDate')),
        syncWhenRun: false,
      }),
  ],
] as const) {
  op(name, () =>
    respond(
      forEach(ref(findReminders(text(field('title'))), 'Reminders'), () =>
        when(
          property(repeatItem, 'title'),
          text(field('title')),
          () => {
            act(repeatItem)
            record({ title: text(property(repeatItem, 'title')) })
          },
          'nothing',
        ),
      ),
    ),
  )
}

// Due has no usable Find for timers (the action is missing in Shortcuts), so timers are named directly and Due
// resolves the name itself.
for (const [name, intent] of [
  ['timers.start', 'StartTimerIntent'],
  ['timers.pause', 'PauseTimerIntent'],
  ['timers.stop', 'StopTimerIntent'],
] as const) {
  op(name, () => {
    const timer = due(intent, {
      timer: text(field('name')),
      syncWhenRun: false,
    })
    respond(
      ref(record({ name: text(asText(ref(timer, 'Timer'))) }), 'Dictionary'),
    )
  })
}

await mkdir('dist', { recursive: true })
const unsigned = await s.write('dist/swiss-due.unsigned.shortcut')
console.log(Shortcut.sign(unsigned, 'dist/swiss-due.shortcut'))
