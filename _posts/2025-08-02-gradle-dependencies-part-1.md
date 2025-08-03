---
layout: post
title: 'Gradle Dependencies, Part 1: Modules, Configurations, and Variants, Oh My!'
author: Luke Bemish
---

If you've ever worked with [Gradle](https://gradle.org/) (a build tool primarily targetted at Java or Android environments), you've likely used dependencies. And if you've ever used other Java-focused build tools, such as Maven, you'll likely have noticed that dependencies in Gradle can be much more complex! Configurations? Variants? Attributes? What all is going on here, exactly? In this series of posts I will attempt to pull apart Gradle's dependency management system, answering some questions I often see about it. In this first post, I'll provide an overview of the core parts of the model.

Gradle is configured using buildscripts, (hopefully) small files specifying the details of your build, written in Kotlin or Groovy. Throughout this post (and the following posts) I'll provide a few examples; unless otherwise specified, I'll be talking about Gradle 9.0.0, the most recent version at the time of this writing, and will provide my examples in Groovy (though the Kotlin version should be fairly similar, if not identical). I may also provide some examples written in Java; this is what you might expect to see inside of a Gradle plugin, a third-party extension to Gradle implementing some functionality that could consume part of the dependency model.


## What's in a dependency?

A dependency declaration in Gradle looks something like the following:

```gradle
dependencies {
    api("org.example.group:name:1.2.3")
}
```

Within the `dependencies` block, you can specify dependencies in any number of different _configurations_. A configuration is somewhat similar to a scope in Maven; in effect, it specifies when the dependency should be used. For instance, the above example adds a dependency to the `api` configuration. This means that that dependency should be available on the classpath when building your code, should be available on the classpath when running your code, and should be available on the classpath when anything that depends on your project compiles or runs. In other words, the dependency is transitive. This is comparable to Maven's `compile` scope.

> [!NOTE]
> Unlike maven, which has a fixed collection of built-in scopes, Gradle's configurations have to be created; in this case, the `api` configuration is created by the built-in `java-library` plugin. This plugin creates [several other configurations](https://docs.gradle.org/9.0.0/userguide/dependency_configurations.html#sub:what-are-dependency-configurations) as well; for instance, `runtimeOnly` is available at runtime, including transitively, but not at compile-time.

The remaining piece of the dependency declaration, `org.example.group:name:1.2.3`, tells Gradle where the dependency in question is located. The _group_ of the dependency is `org.example.group`; it declares the owner of a package in some sense, potentially grouping together similar packages from the same organization via subgroups. The _module name_ is `name`, and identifies a single module within that group; that module may have many versions.

You may see the whole string `org.example.group:name:1.2.3` referred to as a "GAV"; this terminology (group ID/artifact ID/version) comes from Maven, where such a string can uniquely locate a file within a repository. I will avoid using this terminology, both because "artifact" has another meaning in Gradle and because, as we will see, unlike in Maven, in Gradle this string doesn't necessarily uniquely locate a single file. Instead, I will talk about the _module identifier_ (the group ID and module name) and the _module component identifier_ (a module identifier along with a version).

> [!NOTE]
> Generally speaking, the group and module name follow the conventions used for Maven coordinates, with the group an all lowercase inverted domain name and the module name containing only lowercase letters, digits, and hyphens. Gradle doesn't actually enforce either of these as requirements; however, like with Maven, publishing a package which breaks either of these expectations may result in being unable to publish the package to certain repositories. GitHub's package system, for instance, assumes that the module name follows Maven conventions, and repositories like Maven Central require ownership of the domain name used as a group.

The final piece of the coordinates, the version, defines a _required_ version. Gradle allows for several different types of version declarations:
- **strictly**: the strongest requirement; the version of a dependency resolved must _exactly_ match the version declared.
- **require**: the default requirement; the version resolved must be _at least_ the version specified here, but might be upgraded.
- **prefer**: the weakest requirement; gives a suggestion for the resolved version, but is weaker than `strictly` or `require`.
- **reject**: marks certain versions as _not_ resolvable.

Of note, `require` and `strictly` cannot be used together, and both `require` and `strictly` must be declared before `reject`. With the exception of `prefer`, these may all be used with version ranges (or, in Gradle terminology, dynamic versions). For instance, the following:

```gradle
dependencies {
    api("org.example.group:name") {
        version {
            strictly("[1.0.0,2.0.0)")
            prefer("1.2.3")
        }
    }
}
```

Will tell Gradle that it may resolve any version from `1.0.0` (inclusive) to `2.0.0` (exclusive), but should prefer `1.2.3` if nothing else upgrades the version. Gradle's dependency version declarations have a fairly extensive syntax, which I will not go into further here, but you can read more [in the Gradle docs](docs.gradle.org/9.0.0/userguide/dependency_versions.html).


## Variants and configuration roles

Let's say that you depend on a library using `api` as above, and publish your own component under `gizmo:gadget`. If somebody depends on your component, how does Gradle ensure that they end up with the library you depended on transitively? To understand this, we need to delve into the realm of variants, beginning with a discussion of configuration roles.

Configurations can, in fact, do one of three different tasks. By and large, these three tasks are completely separate and do not interact with each other, but the same configuration can, depending on how it is configured, do all three (though Gradle seems to be [moving in a direction to address this](https://docs.gradle.org/9.0.0/userguide/declaring_configurations.html#configuration_api_incubating_methods), with configurations increasingly having only a single role). These roles are:
- **Dependency Scope**: configurations let you declare dependencies: this is what configurations you use in the `dependencies` block, like `api`, do.
- **Resolvable**: configurations are used to resolve dependencies: for instance, to build the list of files used on the compile classpath.
- **Consumable**: configurations are used to expose dependencies to things consuming the project, making transitive dependencies possible.

Most of the configurations from Gradle's built-in plugins perform only one of these roles, but even if a configuration performs multiple, the different roles can generally be thought of separately.

As an example, consider the following two projects:

```gradle
// gizmo:gadget's build.gradle

dependencies {
    api("foo:bar:1.1.0")
    api("bannana:apple:3.0.0")
}

// consuming build.gradle

dependencies {
    api("gizmo:gadget:2.0.0")
    api("foo:bar:1.0.0")
}
```
Suppose we are interested in resolving the compile classpath in the consuming project (as Gradle does when we build that project). The `compileClasspath` configuration is a resolvable configuration that extends from `api`; extending from a configuration inherits the extended configuration's dependencies, and `compileClasspath` is _not_ a dependency scope configuration, so it cannot have dependencies added itself. To resolve the configuration, Gradle first locates a component matching each dependency from the available repositories. Then, it selects a variant from that component, collects dependencies from that variant, and repeats the process until everything is resolved:
{% goat %}
 .----------------------------.            .-----------------------------.            .-----------------------------.
|Consuming Project             |          |gizmo:gadget:2.0.0             |          |foo:bar:1.1.0                  |
|  .------------------------.  |          |  .-------------------------.  |          |  .-------------------------.  |
| |api                       | |          | |apiElements                | |          | |apiElements                | |
| |  .--------------------.  | |          | |  .---------------------.  | |          | |  .---------------------.  | |
| | |dendencies            | | |          | | |dendencies             | | |    +------>+ |dendencies             | | |
| | |  .----------------.  | | |          | | |  .-----------.        | | |    |     | |  '---------------------'  | |
| | | |gizmo:gadget:2.0.0| | | |     +----->+ | |foo:bar:1.1.0|       +--------+     |  '-------------------------'  |
| | |  '----------------'  | | |     |    | | |  '-----------'        | | |    |      '-----------------------------'
| | |  .-----------.       | | |     |    | | |  .-----------------.  | | |    |
| | | |foo:bar:1.0.0|      | | |     |    | | | |bannana:apple:3.0.0| | | |    |      .-----------------------------.
| | |  '-----------'       | | |     |    | | |  '-----------------'  | | |    |     |bannana:apple:3.0.0            |
| |  '---------------+----'  | |     |    | |  '---------------------'  | |    |     |  .-------------------------.  |
|  '-----------------|------'  |     |    |  '-------------------------'  |    |     | |apiElements                | |
|                    |         |     |     '-----------------------------'     |     | |  .---------------------.  | |
|                    |         |     |                                         +------>+ |dendencies             | | |
|    inherits dependencies     |     |     .-----------------------------.           | |  '---------------------'  | |
|                    |         |     |    |foo:bar:1.0.0                  |          |  '-------------------------'  |
|                    |         |     |    |  .-------------------------.  |           '-----------------------------'
|  .-----------------|------.  |     |    | |apiElements                | |
| |compileClasspath  v       | |     |    | |  .---------------------.  | |
| |  .---------------+----.  | |     |    | | |dendencies             | | |
| | |dependencies          +---------+----->+  '---------------------'  | |
| |  '--------------------'  | |          |  '-------------------------'  |
|  '------------------------'  |           '-----------------------------'
 '----------------------------'
{% endgoat %}
In this case, a variant named `apiElements` is selected from each component. If this process would result in multiple versions of the same module (here, `foo:bar` was first picked with version `1.0.0`, but was later selected with version `1.1.0`), then Gradle will pick the version that fits all version requirements: here, `1.1.0`, and the dependency on `foo:bar:1.0.0` is upgraded. This can be seen if we run `./gradlew dependencies --configuration=compileClasspath`:
```
compileClasspath - Compile classpath for source set 'main'.
+--- gizmo:gadget:2.0.0
|    +--- foo:bar:1.1.0
|    \--- bannana:apple:3.0.0
\--- foo:bar:1.0.0 -> 1.1.0
```
> [!NOTE]
> When variants are resolved, the process is slightly more complex than described above; notably, Gradle won't even bother to look for a variant if it knows, due to a component found at an earlier level of resolution, the component in question would be upgraded. This doesn't have much of an impact, in practice, but _does_ mean that in some cases you may resolve a tree where certain transitive dependencies don't exist in your available repositories, if those dependencies are upgraded at an earlier level to versions that do.

Components model a single package, in some form. Variants model multiple the options available once we've selected a component. For instance, are we looking for something to compile against, or something to run with? Are we looking for a binary library, or its sources? Variants contain both dependencies and artifacts. When a project is published, variants are produced from configurations. For instance, if we take a look at the publishing for `gizmo:gadget`:
```gradle
dependencies {
    api("foo:bar:1.1.0")
    api("bannana:apple:3.0.0")
}

publishing {
    publications {
        mavenJava(MavenPublication) {
            from components.java
        }
    }
}
```
We see that we are publishing a single component, `components.java` (In a java project, this is likely the only component you will ever see). Each component has a list of variants attached to it, each backed by a consumable configuration. For instance, the `apiElements` configuration is a consumable configuration that extends from `api`. We can see consumable configurations of a project by running `./gradlew outgoingVariants`; here, the info dumped about `apiElements` looks like:
```
--------------------------------------------------
Variant apiElements
--------------------------------------------------
API elements for the 'main' feature.

Capabilities
    - gizmo:gadget:2.0.0 (default capability)
Attributes
    - org.gradle.category            = library
    - org.gradle.dependency.bundling = external
    - org.gradle.jvm.version         = 21
    - org.gradle.libraryelements     = jar
    - org.gradle.usage               = java-api
Artifacts
    - build/libs/gadget-2.0.0.jar (artifactType = jar)
```
This tool does not print dependencies, but they are visible with `./gradlew dependencies` as before. Since published variants are really just consumable configurations, cross-project dependencies within a build and remote dependencies act very nearly the same.

## Attribute selection

So how does Gradle pick which variant of a component to resolve to? Well, as we saw at the end of the last section, each variant declares a set of _attributes_; these are key-value pairs that tell Gradle what sort of stuff a variant contains. For instance, the `org.gradle.usage` tells gradle when a variant can be used, with `java-api` indicating a variant meant to be compiled against (such as `apiElements` above), or `java-runtime` indicating a variant meant to be on the runtime classpath (such as `runtimeElements`, the runtime equivalent to `apiElements`). Each resolvable configuration has its own set of attributes. We can run `./gradlew resolvableConfigurations` to see these; for instance, from `compileClasspath`:
```
--------------------------------------------------
Configuration compileClasspath
--------------------------------------------------
Compile classpath for source set 'main'.

Attributes
    - org.gradle.category            = library
    - org.gradle.dependency.bundling = external
    - org.gradle.jvm.environment     = standard-jvm
    - org.gradle.jvm.version         = 21
    - org.gradle.libraryelements     = classes
    - org.gradle.usage               = java-api
```
When resolving, gradle only picks variants with compatible attribute values, and then tries to narrow those down to the variant with the _best_ matching attribute values. To pick between variants, gradle first picks those variants whose attribute values match what was requested; these do not have to be exact matches, and you may define [compatibility rules](https://docs.gradle.org/9.0.0/userguide/variant_attributes.html#sec:abm-compatibility-rules) that are used at this stage. Of the remaining variants, gradle attempts to pick the best match by applying [disambiguation rules](https://docs.gradle.org/9.0.0/userguide/variant_attributes.html#sec:abm-disambiguation-rules). If no variants remain, or if more than one variant remains, resolution (and likely the build) fails.

> [!NOTE]
> For a more in-depth discussion of the algorithm used for selection, see the section on the [attribute matching algorithm](https://docs.gradle.org/9.0.0/userguide/variant_aware_resolution.html#sec:abm-algorithm) in the gradle docs.

Attributes are what allow a single component to have separate transitive runtime and compile-time dependencies; these are exposed in separate variants, and the consuming project's `runtimeClasspath` and `compileClasspath` resolvable configurations have different attributes. Attributes are quite flexible; they can be used to select the sources or javadoc of dependencies, provide different artifacts compatible with different JVM versions, or distinguish between native binaries for different architectures. Since artifacts are attached to variants, this explains why a module component identifier may not uniquely identify a file on a given repository in Gradle, unlike how a GAV works in Maven: different variants on the published component could expose different artifacts.

_Part 2: Capabilities and Artifacts hopefully coming soon!_

_Have questions or thoughts? Feel free to reach out to me at [lukebemish@lukebemish.dev](mailto:lukebemish@lukebemish.dev)_
