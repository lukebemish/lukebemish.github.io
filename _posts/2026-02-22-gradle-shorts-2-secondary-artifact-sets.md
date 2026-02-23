---
layout: post
title: 'Gradle Dependency Resolution Shorts: Secondary Artifact Sets'
author: Luke Bemish
categories:
  - Gradle Dependencies
---

Gradle's `ConfigurationPublications` API (accessible through `Configuration#getOutgoing()`) contains an API for declaring
secondary artifact sets (previously referred to as secondary variants). Secondary artifact sets currently have some
likely-buggy behavior when resolving, and are published as full variants which can result in differences in resolution between
projects and equivalent published metadata.

The place secondary artifact sets normally show up often in a Gradle build is the
`classes` and `resources` secondary artifact sets Gradle attaches to `runtimeElements` and `apiElements` when the `java-library`
plugin is applied. These are unpublished, and the `classes` secondary artifact set of `apiElements` allows the compilation
of dependents to avoid needlessly compressing JAR files by just selecting the compiled classes instead.

Secondary artifact sets effectively work as precomputed artifact transforms: like artifact transforms, they don't affect
variant selection but may be selected during artifact selection. They have their own attributes and artifacts, though by
default inherit the attributes of their parent configuration. They are published if their parent configuration
is a published variant, unless they are explicitly skipped.

Gradle's built-in secondary artifact sets all seem to be skipped at publication, so let's look at what happens if we publish
one. Say we set up the following:

```groovy
// build.gradle for :foo
plugins {
    id 'base'
    id 'maven-publish'
}

group = 'org.example'
version = '1.0.0'

def someAttribute = Attribute.of("someAttribute", String)

configurations {
    consumable("someVariant") {
        attributes {
            attribute(someAttribute, "gizmo")
        }
        outgoing.variants {
            register("secondary") {
                attributes {
                    attribute(someAttribute, "gadget")
                }
            }
        }
    }
}

publishing {
    def component = softwareComponentFactory.adhoc('other')
    component.addVariantsFromConfiguration(configurations.someVariant) {}
    publications {
        maven(MavenPublication) {
            from component
        }
    }
}
```

Looking at the `outgoingVariants` report, we'll see the following:

```
--------------------------------------------------
Variant someVariant
--------------------------------------------------

Capabilities
    - org.example:foo:1.0.0 (default capability)
Attributes
    - someAttribute = gizmo

Secondary Variants (*)

    --------------------------------------------------
    Secondary Variant secondary
    --------------------------------------------------
    
    Attributes
        - someAttribute = gadget
```

While the primary artifact set can be resolved "normally", the secondary artifact set (like the result of an artifact transform) would only show
up for artifact selection if variant selection passes (i.e., either with a disambiguation or compatibility rule present on the
attribute, or if we use an artifact view). Depending on the root configuration should look something like:

```groovy
// build.gradle for :bar
plugins {
    id 'base'
}

def someAttribute = Attribute.of("someAttribute", String)

configurations {
    dependencyScope("foo")
    resolvable("fooResolved") {
        extendsFrom foo
        attributes {
            attribute(someAttribute, "gizmo")
        }
    }
}

dependencies {
    foo(project(':foo'))
}

tasks.register("resolveFoo") {
    dependsOn(files(configurations.fooResolved))
}
```

If we try and resolve this, however, we get a variant selection failure:

```
Could not determine the dependencies of task ':bar:resolveFoo'.
> Could not resolve all dependencies for configuration ':bar:fooResolved'.
   > No variants of project :foo match the consumer attributes:
       - Configuration ':foo:someVariant' variant secondary:
           - Incompatible because this component declares attribute 'someAttribute' with value 'gadget' and the consumer needed attribute 'someAttribute' with value 'gizmo'
```

Welp. Removing the secondary artifact set, or making it a proper configuration of its own, stops this behavior from occurring.
Adding an artifact to `someVariant` also fixes resolution here; it seems that secondary artifact sets cause resolution
failures if attached to variants without artifacts. In particular, while variant selection passes and picks the containing
configuration, artifact selection fails, instead of just picking the empty artifact set of the root variant like would happen
without a secondary artifact set. This seems like a bug and I've opened [an issue](https://github.com/gradle/gradle/issues/36834).

Regardless! Assuming we attach some artifacts so that stuff resolves nicely, if we publish `:foo` we can look at the resulting module metadata:

```jsonc
"variants": [
  {
    "name": "someVariant",
    "attributes": {
      "someAttribute": "gizmo"
    },
    "files": [
      //...
    ]
  },
  {
    "name": "someVariantSecondary",
    "attributes": {
      "someAttribute": "gadget"
    },
    "files": [
      //...
    ]
  }
]
```

Turns out secondary artifact sets are published as full variants, which is unsurprising since there's nothing in the module
metadata spec that could represent them otherwise. However, this makes it possible to create a module that will select a
different variant in a cross-project dependency than when published using this setup. For instance, with

```gradle
def attributeA = Attribute.of("attribute.a", String)
def attributeB = Attribute.of("attribute.b", String)

configurations {
    consumable("a") {
        attributes {
            attribute(attributeA, "gizmo")
        }
        outgoing.variants {
            register("secondary") {
                attributes {
                    attribute(attributeA, "gadget")
                    attribute(attributeB, "value")
                }
            }
        }
    }
    consumable("b") {
        attributes {
            attribute(attributeA, "gadget")
        }
    }
}
```

A project dependency asking for `attribute.a=gadget`, `attribute.b=value` will select `b`, while when published that same
combination will end up selecting `aSecondary`. This includes a "project dependency" that's a substituted build via `includeBuild`,
which means we need to add secondary artifact sets to the long list of things-to-be-careful-with when using included builds,
since they could result in an included build acting differently than depending on the published component.

With all this in mind, I'm not quite sure what the use cases are for published secondary artifact sets (or why they're published-by-default), since they act just like
normal variants when published.