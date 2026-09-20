import type { BenchmarkScenario, BenchmarkTrial } from './types.js';

/** Условия и ожидаемые результаты принадлежат стенду; модель не может менять проверки. */
export const scenarios: BenchmarkScenario[] = [
  {
    id: 'independent',
    title: 'Независимые файлы',
    goal: 'Исправьте square.js: square(x) возвращает x*x; double.js: double(x) возвращает x*2.',
    files: {
      'square.js': 'export const square = x => x + 2;\n',
      'double.js': 'export const double = x => x + 1;\n',
    },
    parts: [
      {
        title: 'Исправьте square(x): x*x в square.js.',
        role: 'executor',
        reads: ['square.js'],
        writes: { 'square.js': 'export const square = x => x * x;\n' },
      },
      {
        title: 'Исправьте double(x): x*2 в double.js.',
        role: 'executor',
        reads: ['double.js'],
        writes: { 'double.js': 'export const double = x => x * 2;\n' },
      },
    ],
    finalWrites: {},
    checks: [
      {
        title: 'Квадрат положительного и отрицательного числа',
        assertion:
          "const {square}=await load('square.js'); assert.equal(square(5),25); assert.equal(square(-3),9);",
      },
      {
        title: 'Удвоение и нулевое значение',
        assertion:
          "const {double}=await load('double.js'); assert.equal(double(7),14); assert.equal(double(0),0);",
      },
    ],
    fixedPlan: {
      mode: 'parallel',
      reason: 'Файлы независимы; каждой ветке назначен один файл.',
      tasks: [],
    },
  },
  {
    id: 'refactor',
    title: 'Связанный рефакторинг',
    goal: 'Переведите fullName и greeting на аргумент-объект {first,last}. greeting возвращает Hello, Ada Lovelace. Согласуйте name.js и greeting.js.',
    files: {
      'name.js': 'export const fullName = (first, last) => first + " " + last;\n',
      'greeting.js':
        'import {fullName} from "./name.js";\nexport const greeting = (first,last) => "Hello, " + fullName(first,last);\n',
    },
    parts: [
      {
        title: 'Измените общий контракт и его потребителя согласованно.',
        role: 'executor',
        reads: ['name.js', 'greeting.js'],
        writes: {
          'name.js': 'export const fullName = ({first,last}) => first + " " + last;\n',
          'greeting.js':
            'import {fullName} from "./name.js";\nexport const greeting = person => "Hello, " + fullName(person);\n',
        },
      },
    ],
    finalWrites: {},
    checks: [
      {
        title: 'Новый контракт имени',
        assertion:
          "assert.equal((await load('name.js')).fullName({first:'Ada',last:'Lovelace'}),'Ada Lovelace');",
      },
      {
        title: 'Потребитель использует новый контракт',
        assertion:
          "assert.equal((await load('greeting.js')).greeting({first:'Ada',last:'Lovelace'}),'Hello, Ada Lovelace');",
      },
    ],
    fixedPlan: {
      mode: 'handoff',
      reason: 'Контракт и потребитель зависимы: одна ветка меняет оба.',
      tasks: [],
    },
  },
  {
    id: 'test-repair',
    title: 'Исправление теста',
    goal: 'Исправьте ошибочное ожидание 2+2=5 в add.test.js. Сохраните add.js и проверку assert.equal: результат должен равняться 4.',
    files: {
      'add.js': 'export const add = (a,b) => a+b;\n',
      'add.test.js':
        'import assert from "node:assert/strict";\nimport {add} from "./add.js";\nassert.equal(add(2,2),5);\n',
    },
    parts: [
      {
        title: 'Исправьте только ошибочное ожидание теста.',
        role: 'executor',
        reads: ['add.js', 'add.test.js'],
        writes: {
          'add.test.js':
            'import assert from "node:assert/strict";\nimport {add} from "./add.js";\nassert.equal(add(2,2),4);\n',
        },
      },
    ],
    finalWrites: {},
    checks: [
      {
        title: 'Реализация сложения сохранена',
        assertion:
          "assert.equal(await text('add.js'),'export const add = (a,b) => a+b;\\n'); assert.equal((await load('add.js')).add(3,5),8);",
      },
      {
        title: 'Тест содержит верное ожидание и исполняется',
        assertion:
          "await load('add.test.js'); assert.equal((await load('add.js')).add(2,2),4); assert.equal(assertionCalls().some(([actual,expected])=>actual===4 && expected===4),true);",
      },
    ],
    fixedPlan: {
      mode: 'handoff',
      reason: 'Один локальный тест: передача исполнителю без дробления.',
      tasks: [],
    },
  },
  {
    id: 'research',
    title: 'Исследование',
    goal: 'Изучите runtime.txt и storage.txt; создайте report.json с полями runtime, storage, acceptance на основании этих файлов.',
    files: {
      'runtime.txt': 'Среда исполнения: Node.js. Приёмка результата: human.\n',
      'storage.txt': 'Формат хранения: JSONL.\n',
    },
    parts: [
      {
        title: 'Изучите runtime.txt: среда и приёмка.',
        role: 'researcher',
        reads: ['runtime.txt'],
        writes: {},
      },
      {
        title: 'Изучите storage.txt: формат хранения.',
        role: 'researcher',
        reads: ['storage.txt'],
        writes: {},
      },
    ],
    finalWrites: {
      'report.json': '{"runtime":"Node.js","storage":"JSONL","acceptance":"human"}\n',
    },
    checks: [
      {
        title: 'Отчёт соответствует двум источникам',
        assertion:
          "assert.deepEqual(JSON.parse(await text('report.json')), {runtime:'Node.js',storage:'JSONL',acceptance:'human'});",
      },
    ],
    fixedPlan: {
      mode: 'parallel',
      reason: 'Источники читаются независимо; координатор объединяет факты.',
      tasks: [],
    },
  },
  {
    id: 'overlap',
    title: 'Пересекающиеся изменения',
    goal: 'В settings.json нужно одновременно изменить timeout на 10 и retries на 2, сохранив enabled=true. Оба изменения затрагивают один объект.',
    files: { 'settings.json': '{"timeout":1,"retries":0,"enabled":true}\n' },
    parts: [
      {
        title: 'Согласуйте обе правки общего файла без потери полей.',
        role: 'executor',
        reads: ['settings.json'],
        writes: { 'settings.json': '{"timeout":10,"retries":2,"enabled":true}\n' },
      },
    ],
    finalWrites: {},
    checks: [
      {
        title: 'Обе правки и исходное поле сохранены',
        assertion:
          "assert.deepEqual(JSON.parse(await text('settings.json')), {timeout:10,retries:2,enabled:true});",
      },
    ],
    fixedPlan: {
      mode: 'direct',
      reason: 'Обе правки пересекаются: общий файл меняет один исполнитель.',
      tasks: [],
    },
  },
];

for (const scenario of scenarios) {
  if (scenario.fixedPlan.mode !== 'direct')
    scenario.fixedPlan.tasks = scenario.parts.map((part, index) => ({
      role: part.role,
      task: `[BENCH:${scenario.id}:part${index}] ${part.title}`,
      context: scenario.goal,
    }));
}

/** Чередует режимы внутри повторов, не группируя все одиночные запуски в начало. */
export function benchmarkOrder(): BenchmarkTrial[] {
  const modes = ['solo', 'fixed', 'auto'] as const;
  const trials: BenchmarkTrial[] = [];
  for (let repeat = 1; repeat <= 3; repeat++)
    for (const [scenarioIndex, scenario] of scenarios.entries())
      for (let shift = 0; shift < modes.length; shift++)
        trials.push({
          index: trials.length + 1,
          scenario: scenario.id,
          repeat,
          mode: modes[(shift + repeat + scenarioIndex - 1) % 3]!,
        });
  return trials;
}
