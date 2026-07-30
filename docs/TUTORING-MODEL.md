# How Marg Decides What To Do

Written so a product manager or frontend engineer can predict Marg's behaviour
without reading a single prompt.

---

## The shape of a turn

Every message a student sends goes through the same six steps:

```
  student message
        │
        ▼
  1. TRIAGE      one cheap AI call: in scope? what kind of help?
        │
        ▼
  2. GUARD       should we proceed, or redirect?  ──── refused ──► warm redirect (HTTP 200)
        │
        ▼
  3. MODE        guide / explain / discuss / check
        │
        ▼
  4. GATE        wants the answer? has it been unlocked?
        │
        ▼
  5. GENERATE    the teaching call, streamed or not
        │
        ▼
  6. RECORD      transcript, step statuses, mistake log
```

Triage runs on a small, cheap model. It happens **before** the expensive
teaching call, so an off-topic request costs one tiny classification and
nothing more.

---

## The four modes

The landing page shows two things that look like separate features — the
stepped card with `01 / 02 / 03`, and loose chat bubbles like *"wait, why does
the sign flip here?"*. They are **not two apps**. They are two behaviours inside
one session, and a session moves between them freely.

| Mode | What Marg does | Typically triggered by |
|---|---|---|
| **guide** | Works through the current step *only*. Asks the student to try it before showing anything. Under four sentences. | The default on session creation; "walk me through it" |
| **explain** | Explains why one thing works — the reasoning, not just the rule. Does not drift into solving the rest. | The "See a worked example ↓" button; "why does the sign flip here?" |
| **discuss** | A conceptual question with no step attached. Intuition first, then the formal version. | "what's the intuition for eigenvalues?" |
| **check** | Marks a submitted attempt. Says what is right first, then the first place it broke. | "Check my work"; pasted working |

### Explicit beats inferred

The frontend can force a mode by passing `mode` on the request. When it does,
that wins — the student pressed a button, and second-guessing them with a
classifier would be both surprising and worse.

When no mode is passed, triage reads it from the message. So a UI button and a
student typing *"just tell me the answer"* both land in the right place. That is
what makes the card and the chat feel like one product.

One deterministic override: if `attempt` is present in the request, the mode is
`check` regardless of the wording. A student who pastes their working and types
"I think this is right?" wants it marked, not discussed.

---

## The answer gate

**Answering "will it just give away the answer?" — yes, but not on the first ask.**

Three policies, set per session with `answerPolicy` when you create it:

| Policy | Behaviour |
|---|---|
| `on_request` *(default)* | 1st ask → a real hint, plus an honest offer. 2nd ask → the full worked solution. |
| `after_attempt` | The answer unlocks only once the student has submitted an attempt. Best for teacher-configured sessions. |
| `never` | Hints only, forever. |

### Why friction rather than refusal

A student at 1am before a deadline is going to get the answer somewhere. If Marg
refuses outright, they open another tab and learn nothing. The friction is one
extra beat to try again — not a wall. And Marg says so plainly, with no
guilt-tripping and no bargaining: *wanting the answer is allowed*.

### Why it is code, not a prompt

"Do not give away the answer" written in a system prompt is a **suggestion**. A
student who asks firmly enough, or pastes *"ignore your previous instructions"*,
will often get it.

So the gate is a state machine in `tutorService.js`, and the answer is simply
**not in the prompt** until the state machine opens. A model cannot leak what it
was never told. The prompt rule and the code check back each other up.

The `finalAnswer` field also never appears in any API response — responses are
built from an allow-list of fields, so a student cannot read the answer out of
the network tab either.

### What the frontend sees

| Field | Meaning |
|---|---|
| `revealed` | The full answer was just handed over |
| `revealAvailable` | Asking once more *would* unlock it — show the button |
| `requirement` | Why it is still locked: `ask_again`, `attempt_first`, `policy_never` |

When `revealAvailable` is `false` and `revealed` is `false`, the gate can never
open. Hide the button.

**Hints do not consume the gate.** Asking for a hint is not asking for the
answer, and it is never held against the student.

---

## The guardrails

Two gates, in order.

### Gate 1 — Topic

Is this study-related at all?

**In scope:** the eight subjects, study skills, exam technique, and questions
about Marg itself.

**Out of scope** → a warm redirect: *"That one is outside what I do — I'm built
for working through study problems."* It names what *would* work, so the student
has an obvious next move.

### Gate 2 — Academic integrity

Even for a real school subject: does the student want to **learn** it, or to
have it **done**?

| Request | What happens |
|---|---|
| "Why does my for loop go out of bounds?" | ✅ Full tutoring — this is the product |
| "Here's my assignment spec, write the program" | ❌ Won't emit the file. Walks them to it, reviews their attempt |
| "Explain how recursion works" | ✅ Concept explanation |
| "Write my 1500-word essay on the French Revolution" | ❌ Won't produce it. Will outline, coach, critique a draft |
| "Help me structure my essay on the French Revolution" | ✅ Structuring is coaching |
| "Analyse the metaphors in these Spanish song lyrics" | ✅ Literary analysis for a Languages class |
| "Write me a song for my girlfriend's birthday" | ❌ Out of scope |
| "What can you do?" | ✅ Always answered |

### Why the obvious rule would be wrong

The instinct is *"Marg shouldn't write code or songs."* Both halves of that
break the product.

**It cannot refuse code.** Programming is one of the eight subjects on the
landing page. Debugging a loop, explaining recursion, reviewing an attempt —
that is the product working exactly as designed.

**It cannot ban "song".** A Languages student analysing Spanish lyrics, or a
poetry unit scanning meter, is doing legitimate schoolwork.

So the axis is **learning vs. outsourcing** — never the topic. A keyword ban
would produce false refusals, and an app that declines to help debug a for loop
feels broken in a way no error log will ever show you.

The test suite asserts every row of that table, including the false-refusal
cases, precisely because they are the ones nobody notices going wrong.

### How a refusal is delivered

**HTTP 200, `ok: true`,** with a normal assistant message and
`meta.refused: true`. Render it as an ordinary chat bubble.

A 4xx would make the frontend show an error state for what is really a perfectly
normal thing for a tutor to say. A redirect is a conversation, not a failure.

When Marg declines the artifact, it pivots to teaching the same material in the
same breath:

> I'm not going to produce that one for you — it's the bit you're being marked on.
>
> I'd rather get you there than hand it over. Tell me what the program needs to
> do and where you're stuck, and we'll build it a piece at a time — I'll check
> each bit as you go.

No scolding, no mention of cheating, and never a dead end.

### Meta questions are never gated

Greetings, "what can you do?", "how do I use this?" — always answered. Refusing
these is the classic guardrail bug: the very first thing a new user types gets
rejected, and the app feels hostile before it has helped anyone with anything.
It is checked before every other rule.

### Turning it off

`STRICT_SCOPE=false` disables both gates, for demos or internal builds.

### When triage fails

If the classification call itself errors, the request is **allowed through** as
a normal academic question. A student wrongly refused help is a far worse
outcome than an off-topic message slipping past — and the system prompt still
holds the line on the second one.

---

## Marking

`POST /sessions/:id/check` is the product's centrepiece: *"get marked, not just
graded."*

What comes back:

- **`firstBrokenStepIndex`** — the one step to circle. Everything after a broken
  step is usually downstream of the same mistake, so marking four steps wrong
  for one error would be both misleading and demoralising.
- **Per-step verdicts** — `correct`, `partially_correct`, `incorrect`, `not_attempted`.
- **`errorType`** — a consistent snake_case tag (`sign_error`, `unit_conversion`,
  `off_by_one`…) that feeds the mistake log.
- **`nudge`** — what to try next. Never contains the final answer, and is usually
  phrased as a question: *"Take 2x + 1 = 0 on its own — what is x?"*

Feedback always leads with what was **right**. Starting on the error makes a
student read the rest defensively, and they stop taking in the correction.

---

## The mistake log

Every marked error is recorded with its skill tag. On its own one row is not
interesting; the value is the pattern across weeks:

> *"Sign errors came up 4 times, mostly in factoring."*

That is the thing a human tutor does that a grading app does not — they remember
last week. `GET /insights/weaknesses` returns it with a ready-to-render
`summary` string.

The aggregation is plain arithmetic, not an AI call: counting mistakes should be
instant, free, and identical every time the page loads. The AI already did the
hard part when it tagged each error during marking.

The skill tag comes from the **step that broke**, not from the model, so tags
stay consistent across sessions — "factoring" does not drift into "factorising
quadratic expressions" next week, and the counts actually add up.

---

## Tone

From the landing page: *"like a tutor leaning over your shoulder, minus the
schedule."*

- Short sentences, plain words, no lecturing
- Warm but not gushing — *"Nice, that's the tricky part"* beats *"Amazing job!!!"*
- One idea per reply. Notice three problems, mention the first
- Ask more than you tell
- Point at the step, never at the student

The persona lives in `src/prompts/tutorSystem.js`. Edits there change Marg's
whole character — treat them the way you would treat edits to a pricing page.
