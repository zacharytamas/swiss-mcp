import { mkdir } from 'node:fs/promises'
import {
  type Action,
  type Attachment,
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
  Value: { ...a.Value, Aggrandizements: [aggrandizement] },
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
const output = (action: Action, name: string): Ref => ({
  WFSerializationType: 'WFTextTokenAttachment',
  Value: {
    Type: 'ActionOutput',
    OutputUUID: String(action.WFWorkflowActionParameters.UUID),
    OutputName: name,
  },
})
const repeatItem: Ref = {
  WFSerializationType: 'WFTextTokenAttachment',
  Value: { Type: 'Variable', VariableName: 'Repeat Item' },
}

const request = s.action('is.workflow.actions.detect.dictionary', {
  WFInput: shortcutInput(),
})
const field = (key: string) =>
  aggrandize(output(request, 'Dictionary'), {
    Type: 'WFDictionaryValueVariableAggrandizement',
    DictionaryKey: key,
  })

const due = (intent: string, params: Record<string, unknown>) =>
  s.action(`${DUE.BundleIdentifier}.${intent}`, {
    AppIntentDescriptor: { ...DUE, AppIntentIdentifier: intent },
    ShowWhenRun: false,
    ...params,
  } as never)

const findAll = (entity: string) =>
  due(entity, {
    WFContentItemFilter: {
      WFSerializationType: 'WFContentPredicateTableTemplate',
      Value: {
        WFActionParameterFilterPrefix: 1,
        WFContentPredicateBoundedDate: false,
        WFActionParameterFilterTemplates: [],
      },
    },
    WFContentItemLimitEnabled: false,
  })

const when = (value: Ref, equals: TokenString, body: () => void) => {
  const gid = crypto.randomUUID().toUpperCase()
  s.action('is.workflow.actions.conditional', {
    GroupingIdentifier: gid,
    WFControlFlowMode: 0,
    WFInput: subject(value),
    WFCondition: 4,
    WFConditionalActionString: equals,
  })
  body()
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
    dueDate: text(output(due, 'Formatted Date')),
  })
}

const forEach = (items: Ref, body: () => void) => {
  const gid = s.repeatEach(items)
  body()
  return output(s.endRepeatEach(gid), 'Repeat Results')
}

// Each op answers with a JSON array: a dictionary coerces to its JSON text, and the items are comma-joined.
const respond = (items: Ref) => {
  const joined = s.action('is.workflow.actions.text.combine', {
    text: items,
    WFTextSeparator: 'Custom',
    WFTextCustomSeparator: ',',
  })
  s.action('is.workflow.actions.output', {
    WFOutput: text('[', output(joined, 'Combined Text'), ']'),
  })
}

const op = (name: string, body: () => void) =>
  when(field('op'), text(name), body)

op('reminders.list', () =>
  respond(
    forEach(output(findAll('ReminderEntity'), 'Reminders'), () =>
      reminder(repeatItem),
    ),
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
  respond(output(reminder(output(created, 'Reminder')), 'Dictionary'))
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
      forEach(output(findAll('ReminderEntity'), 'Reminders'), () =>
        when(property(repeatItem, 'title'), text(field('title')), () => {
          act(repeatItem)
          record({ title: text(property(repeatItem, 'title')) })
        }),
      ),
    ),
  )
}

op('timers.list', () =>
  respond(
    forEach(output(findAll('TimerEntity'), 'Timers'), () =>
      record({ name: text(asText(repeatItem)) }),
    ),
  ),
)

for (const [name, intent] of [
  ['timers.start', 'StartTimerIntent'],
  ['timers.pause', 'PauseTimerIntent'],
  ['timers.stop', 'StopTimerIntent'],
] as const) {
  op(name, () =>
    respond(
      forEach(output(findAll('TimerEntity'), 'Timers'), () =>
        when(asText(repeatItem), text(field('name')), () => {
          due(intent, { timer: repeatItem, syncWhenRun: false })
          record({ name: text(asText(repeatItem)) })
        }),
      ),
    ),
  )
}

await mkdir('dist', { recursive: true })
const unsigned = await s.write('dist/swiss-due.unsigned.shortcut')
console.log(Shortcut.sign(unsigned, 'dist/swiss-due.shortcut'))
