---
layout: post
title: 'Gradle Dependency Resolution Shorts: Variant Selection, Redux'
author: Luke Bemish
categories:
  - Gradle Dependencies
---

How bad can variant selection and attribute matching be? Gradle's variant selection algorithm has some undocumented behavior: in addition to
attributes, which (if any) variant it picks from those compatible also depends on capabilities, classifiers, and artifact
selectors.

Gradle's attribute matching algorithm used in variant selection, [as documented](https://docs.gradle.org/9.3.1/userguide/variant_aware_resolution.html#sec:abm-algorithm),
seems to look something like this:
{% goat %}
                                    .----------.
                                   | Candidates |
                                    '----+-----'
                                         |
                                         v
                              .----------------------.
           .-----------------+  Find matching         +-----------------.
          |                  |  candidates            |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Longest matching      +------------------+
          |                  |  candidate             |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Disambiguate with     +------------------+
          |                  |  requested attributes  |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Disambiguate with     +------------------+
          |                  |  extra attributes      |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Least extra           +------------------+
          |                  |  attributes            |                  |
No remaining candidates       '----------+-----------'       Single remaining candidate
          |                              |                               |
          |                              v                               v
          |                         .----------.                    .----------.
           '---------------------->|    FAIL    |                  |   SUCCESS  |
                                    '----------'                    '----------'
{% endgoat %}

I'll call this the canonical variant selection pathway. The algorithm starts with a set of candidate variants, and at
each step keeps only a subset of that. At any step it succeeds if one variant remains, or fails if no variants remain or
if it runs out of steps.

The details of those steps are well-documented in the Gradle docs, so I won't get into that here. Instead, lets look at an
example where Gradle _doesn't_ give us the results expected from the canonical variant selection pathway. Consider the following variants:
```
--------------------------------------------------
Variant variant1
--------------------------------------------------

Attributes
    - a = a
    - b = b
    - c = c1

--------------------------------------------------
Variant variant2
--------------------------------------------------

Attributes
    - a = a
    - b = b
    - c = c2

--------------------------------------------------
Variant variant3
--------------------------------------------------

Attributes
    - a = a
    - c = c1
```

Say we have a compatibility rule such that asking for `c=c1` is compatible with values of both `c1` and `c2`, and a
disambiguation rule to prefer `c1` in this case. If we were to resolve against this component asking for `a=a`, `b=b`, and
`c=c1`, we would expect resolution to fail:
- **Find matching candidates**: All three variants are kept
- **Longest matching candidate**: All three variants are kept, as no single variant has a superset of the matching attributes of the other two
- **Disambiguate with requested attributes**: `variant1` and `variant3` are kept, disambiguated on `c` with `c1` preferred over `c2`
- **Disambiguate with extra attributes**: Both `variant1` and `variant3` are kept, as there are no extra attributes to disambiguate on
- **Least extra attributes**: Both `variant1` and `variant3` are kept, as there are no extra attributes to disambiguate on
- **Fail**: Resolution fails, as there are multiple candidates remaining

_However_, if you were to define a set of variants with these attributes, no non-implicit capabilities, and the relevant
disambiguation/compatibility rules and resolve against it, resolution will succeed and `variant1` will be selected. This is
because Gradle's actual variant selection algorithm looks something like:
{% goat %}
                                    .----------.
                                   | Candidates |
                                    '----+-----'
                                         |
                                         v
                              .----------------------.
           .-----------------+  Canonical variant     +-----------------.
          |                  |  selection I           |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Strict capability     +------------------+
          |                  |  matching              |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Canonical variant     +------------------+
          |                  |  selection II          |                  |
          |                   '----------+-----------'                   |
          |                              |                               |
          |                              v                               |
          |                   .----------------------.                   |
          +------------------+  Classifier-based      +------------------+
          |                  |  matching              |                  |
No remaining candidates       '----------+-----------'       Single remaining candidate
          |                              |                               |
          |                              v                               v
          |                         .----------.                    .----------.
           '---------------------->|    FAIL    |                  |   SUCCESS  |
                                    '----------'                    '----------'
{% endgoat %}
We can see this flow in [`GraphVariantSelector#selectByAttributeMatchingLenient`](https://github.com/gradle/gradle/blob/aa1dc49055403e74776c5d6be4a86c50da18855f/platforms/software/dependency-management/src/main/java/org/gradle/internal/component/model/GraphVariantSelector.java#L106-L161).
The canonical variant selection is run twice, sandwiching a strict capability matching step which keeps only candidates
with _exactly_ the set of capabilities requested and none extra, and followed by a classifier-based matching step which, if a
single artifact selector with a classifier is present in the resolution request, keeps only candidates which provide an
artifact with the requested classifier. In the earlier example, for instance:
- **Canonical variant selection I** As above, we are left with `variant1` and `variant3`
- **Strict capability matching**: Both `variant1` and `variant3` are kept, as they have exactly the requested (implicit) capability
- **Canonical variant selection II**: `variant1` is picked in the first step (it is a longest match) and resolution succeeds.

What this means is that variant selection results can differ based on what capabilities your variants have. For instance:
- If we give `variant1` an additional capability, selection will still succeed but `variant3` will be picked instead, as `variant1` will be dropped in the strict capability matching step.
- If we give both `variant1` and `variant3` an additional capability, selection will fail, as both variants will be dropped in the strict capability matching step.

This behavior is as far as I can tell not documented anywhere, and the classifier-matching bit contains a `TODO: Deprecate this` note that I find rather sensible, given
how strange that particular chunk is (artifact selectors having a role in variant selection is a bit odd to say the least!).