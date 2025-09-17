---
layout: post
title: 'Artifacts and Capabilities'
author: Luke Bemish
categories:
  - Gradle Dependencies
redirect_from:
  - /2025/08/03/gradle-dependencies-part-2
---

Once Gradle resolves variants, it locates artifact associated with those variants. However, since Gradle's support for Maven-style dependencies involving classifiers has some potentially unpleasant consequences in this process, Gradle has some of its own solutions to the same problem.

## Artifact selection

Previously, we discussed _variant selection_, in which Gradle, when resolving a dependency on a component, picks a variant to depend on. However, picking a variant is only half the puzzle. The primary purpose of resolving a configuration is often to get a `FileCollection` filled with the artifacts of the resolved dependencies (and to establish proper task dependencies for these artifacts if they're produced by other projects). Normally, of course, this process is quite simple. Configurations may have artifacts attached to them. Like dependencies, these artifacts are inherited when a configuration `extendsFrom` another, and we can once again inspect them with `./gradlew outgoingVariants`. For instance:
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
The `apiElements` configuration has the `gadget-2.0.0.jar` attached. This file is produced by some task (in this case, `:jar`), and will be published alongside the component's metadata. When the `apiElements` variant is selected during resolution, Gradle will then (normally) pick that file, and expose it in the resulting `FileCollection`.

{% alert caution %}
When publishing extra artifacts other than those Gradle sets up by default, it's tempting to manually add them to the publication. After all, Gradle even has a method in the publishing DSL for this:
```gradle
publishing {
    publications {
        mavenJava(MavenPublication) {
            from components.java
            // Don't do this!!!
            artifact project.tasks.makeMySpecialArtifact
        }
    }
}
```
This is, generally speaking, a bad idea (and I'll discuss several alternatives shortly)! An advantage of Gradle's metadata format for published modules is that everything you can access is defined via a variant, unlike in Maven or the like, where published artifacts may or may not have any information about them in the `.pom` file (see, `sources` jars).
{% endalert %}

We can attach new artifacts to a configuration using the `artifacts` DSL:
```gradle
artifacts {
    add("apiElements", tasks.named("alsoApiElementsJar"))
}
```
If we inspect the outgoing variant once again, we see that our new artifact has been added:
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
    - build/libs/gadget-2.0.0-also-api-elements.jar (artifactType = jar, classifier = also-api-elements)
    - build/libs/gadget-2.0.0.jar (artifactType = jar)
```

Gradle doesn't have any issue with a variant having more than one artifact; it'll just fetch all the artifacts attached to the resolved variant.

We also note that the `outgoingVariants` report gives us some other information about the artifact; this information determines the path the artifact is published at within the module (this is _not_ determined by the name of the file the artifact is sourced from! Though if you make an artifact from an `AbstractArchiveTask`, Gradle will pull this information from the task).

### Third-party artifact selectors

Gradle support's Maven's metadata format. When you publish a project using the `maven-publish` plugin, it publishes a maven `.pom` along with its own metadata; when you consume a dependency from a Maven repository, its transitive dependencies (declared in Maven's format) work as expected. Maven GAVs used to locate dependencies are a bit different from a Gradle module component identifier. While a module component identifier might look like:
```
group.id:module-name:version
```
A Maven GAV has some extra (optional) components, and looks like:
```
group.id:module-name:version:classifier@extension
```
Unlike a module component identifier, this _does_ uniquely locate a file on a repository, namely:
```
group/id/module-name/version/module-name-version-classifier.extension
```
(with `classifier` assumed to be empty if missing and `extension` assumed to be `jar`). When a dependency uses Maven metadata, Gradle translates the metadata into its own structure; thus, Gradle needs a way to express the ideas of explicitly choosing extensions and classifiers in its own world of variants. This is why you can depend on a Maven GAV in Gradle:
```gradle
dependencies {
    implementation("group.id:module-name:version:classifier@extension")
}
```
The way Gradle expresses this is through _artifact selectors_; the above dependency is equivalent to:
```gradle
dependencies {
    implementation("group.id:module-name:version") {
        artifact {
            classifier = "classifier"
            extension = "extension"
        }
    }
}
```
And the first thing that we should note here is that artifact selectors have no effect on variant selection, and this can have somewhat obnoxious consequences.

{% alert note %}
I refer here to these as "third-party" artifact selectors, even though this terminology isn't used anywhere in Gradle's docs; _however_, it _is_ used in the published metadata for Gradle modules. If you publish a component with a dependency that uses an extension or classifier, that information is stored in a `thirdPartyCompatibility.artifactSelector` field.
{% endalert %}

### Why artifact selectors sorta suck
Let's consider a perhaps not uncommon case where we might see an artifact selector in use. Say we have the same dependency tree from the last post for `gizmo:gadget`:
```
+--- gizmo:gadget:2.0.0
     +--- foo:bar:1.1.0
     \--- bannana:apple:3.0.0
```
But with the added complexity that `gizmo:gadget` _also_ publishes a file, `gadget-2.0.0-fatjar.jar`, that shadows all its dependencies. So, we decide to depend on it with a Maven GAV:
```
dependencies {
    runtimeOnly("gizmo:gadget:2.0.0:fatjar")
}
```
And now, let's take a look at the resulting contents of `runtimeClasspath`:
```
/<...>/gizmo/gadget/2.0.0/gadget-2.0.0-fatjar.jar
/<...>/foo/bar/1.1.0/bar-1.1.0.jar
/<...>/bannana/apple/3.0.0/apple-3.0.0.jar
```
Uh oh. The `fatjar` jar _contains_ all its dependencies already; we don't want any of those on the classpath! Where'd they all come from?

This behaviour is the fundamental limitation of artifact selectors, and is a direct result of the fact that _artifact_ selection and _variant_ selection are completely separate processes; first Gradle finds a variant, and then it picks an artifact. That means that any transitive dependencies from the selected variant are still resolved; an artifact selector basically just rewrites the list of artifacts attached to the variant and tells Gradle "hey, grab this one instead!". And while that's obviously useful when you're consuming transitive dependencies from Maven modules, it doesn't always interact nicely with all the ins and outs of Gradle dependencies. Gradle's metadata is designed so that the metadata contains all the information about what is available to a consumer; an artifact that needs a selector to be used is in a sense "invisible" to anything consuming your component.

### Avoiding artifact selectors

So, how should you publish your artifacts in a way that means consumers don't need to use artifact selectors? We've already encountered the most simple approach: attributes! This is how Gradle publishes your `sources` jar; it goes in a new outgoing variant, `sourcesElements`:
```
--------------------------------------------------
Variant sourcesElements
--------------------------------------------------
sources elements for main.

Capabilities
    - gizmo:gadget:2.0.0 (default capability)
Attributes
    - org.gradle.category            = documentation
    - org.gradle.dependency.bundling = external
    - org.gradle.docstype            = sources
    - org.gradle.usage               = java-runtime
Artifacts
    - build/libs/gadget-2.0.0-sources.jar (artifactType = jar, classifier = sources)
```

Now, if a consumer wants the sources jar, it merely has to resolve a configuration that would match these attributes. For instance, it might select on the `org.gradle.category` and `org.gradle.docstype` to get just sources jars. We can make a similar variant for our `fatjar` artifact:
```gradle
configurations {
    consumable("fatJarElements") {
        attributes {
            attribute(Usage.USAGE_ATTRIBUTE,
                objects.named(Usage, Usage.JAVA_RUNTIME))
            attribute(Category.CATEGORY_ATTRIBUTE,
                objects.named(Category, Category.LIBRARY))
            attribute(Bundling.BUNDLING_ATTRIBUTE,
                objects.named(Bundling, Bundling.SHADOWED))
        }
    }
}

artifacts {
    fatJarElements tasks.named("fatJar")
}
```
Note the `org.gradle.dependency.bundling` attribute set to `shadowed`; this is one of [Gradle's built-in attributes](https://docs.gradle.org/9.0.0/userguide/variant_attributes.html#sec:standard-attributes). This exposes the artifact on the `fatJarElements` variant:
```
--------------------------------------------------
Variant fatJarElements
--------------------------------------------------

Capabilities
    - gizmo:gadget:2.0.0 (default capability)
Attributes
    - org.gradle.category            = library
    - org.gradle.dependency.bundling = shadowed
    - org.gradle.usage               = java-runtime
Artifacts
    - build/libs/gadget-2.0.0-fatjar.jar (artifactType = jar, classifier = fatjar)
```
This will automatically work out-of-the-box for cross-project dependencies (the only requirements for a configuration to be a visible to other projects as a variant is that it be consumable, and have attributes), but to publish the variant, we need to add it to `components.java`:
```gradle
def javaComponent =
    (AdhocComponentWithVariants) project.components.findByName("java")
javaComponent.addVariantsFromConfiguration(
    configurations.fatJarElements) {}
```
(And yes, that cast is [exactly how Gradle recommends you do this](https://docs.gradle.org/9.0.0/userguide/publishing_customization.html#sec:adding-variants-to-existing-components)) and that's that! Simply publishing `from components.java` will also publish the `fatjar` artifact attached to this variant, and since we didn't add any dependencies to the configuration, the published variant won't have any transitive dependencies either. This is basically what the `com.gradleup.shadow` plugin does to publish the shadow jar it generates.

To consume this variant from another project, we simply need a configuration that would select it by attribute matching. For instance:
```gradle
configurations {
    runtimeClasspath {
        attributes {
            attribute(Bundling.BUNDLING_ATTRIBUTE,
                objects.named(Bundling, Bundling.SHADOWED))
        }
    }
}

dependencies {
    runtimeOnly("gizmo:gadget:2.0.0")
}
```
Here, we tell the `runtimeClasspath` configuration to look for variants with `shadowed` bundling; the relevant variant will be resolved, no artifact selectors needed!

## Capabilities

Using a separate variant with different attributes is great for a sources jar, or javadoc, where the artifact in question has a different _kind_ of stuff, but the stuff really still, as it were, belongs to the same thing, but it's not such a good approach for situations where the artifact contains different stuff altogether in some sense (but is still closely enough related to the rest of your publication to go in the same component).

Let's say, in addition to the main API of `gizmo:gadget`, we have a separate artifact in the same component implementing some service from `gadget` to support another library, `baz`. Attributes aren't really a good tool for expressing this. Attributes are generally attached to the thing doing the consuming (the configuration), not to a single dependency. What we really want is some way of talking about what sort of stuff a variant _contains_. Capabilities give us this tool, but to talk about them we'll need to revise our model of variant selection a bit.

Each variant has a number of _capabilities_ attached to it. A capability looks like a module component identifier; it has a group, a name, and a version. Where an attribute says what _sort_ of stuff a variant contains, a capability tells you _what_ stuff it contains. You can give dependencies capabilities when you declare them; this requires the resolved variant to have that attribute.

The `outgoingVariants` reports in this post in the last all list the capabilities of the variant; all the variants we've looked at so far have had a single capability, which is identical to the module component identifier. This is the implicit capability; unless you specify capabilities, all variants (and all dependencies) have a capability that is identical to their module component identifier.

Though both are involved in satisfying the use cases Maven uses classifiers for, capabilities and attributes are quite different; they're two separate systems involved in variant selection. Attributes match things you might ask many different dependencies for during resolution; for instance, "I want libraries, useable at runtime, packaged as a `.jar`", or "I want javadoc documentation". Capabilities, on the other hand, let you require that the variant picked from a module contain a particular "thing". Where a module identifier encodes where a thing comes from, capabilities encode what it contains. For instance, Google used to have a library called `google-collections`, published under `com.google.collections:google-collections`. This eventually became part of `guava` (at `com.google.guava:guava`); to encode that the new library has, in addition to its own "stuff", all the same "stuff" as the old `google-collections`, Google gave the module's variants the `com.google.collections:google-collections` capability (as well as manually giving them the `com.google.guava:guava` capability, which would no longer be implicitly present otherwise).

Capabilities are the perfect tool for handling the earlier example of wanting to provide an extra artifact of a library implementing some extra functionality, closely enough connected that it ought to be part of the same component. Consider the following dependency declarations:
```gradle
dependencies {
    api("gizmo:gadget:2.0.0") {
        capabilities {
            requireCapability("gizmo:gadget-baz")
        }
    }
    api("gizmo:gadget:2.0.0")
}
```
Resolving `compileClasspath` with these dependencies might look something like this:
{% goat %}
 .---------------------------------------.            .--------------------------------.
|Consuming Project                        |          |gizmo:gadget:2.0.0                |
|  .-----------------------------------.  |          |  .----------------------------.  |
| |api                                  | |          | |apiElements                   | |
| |  .-------------------------------.  | |          | |  .------------------------.  | |
| | |dependencies                     | | |          | | |dependencies              | | |
| | |  .---------------------------.  | | |          | | |  .--------------------.  | | |
| | | |gizmo:gadget:2.0.0           | | | |     +----->+ | |...                   +---------> ...
| | | |  .-----------------------.  | | | |     |    | | |  '--------------------'  | | |
| | | | |requireCapability        | | | | |     |    | |  '------------------------'  | |
| | | | |  gizmo:gadget (implicit)| | | | |     |    | |  .------------------------.  | |
| | | |  '-----------------------'  | | | |     |    | | |capabilities              | | |
| | |  '---------------------------'  | | |     |    | | |  .----------------.      | | |
| | |  .---------------------------.  | | |     |    | | | |gizmo:gadget:2.0.0|     | | |
| | | |gizmo:gadget:2.0.0           | | | |     |    | | |  '----------------'      | | |
| | | |  .----------------------.   | | | |     |    | |  '------------------------'  | |
| | | | |requireCapability       |  | | | |     |    |  '----------------------------'  |
| | | | |  gizmo:gadget-baz      |  | | | |     |    |  .----------------------------.  |
| | | |  '----------------------'   | | | |     |    | |bazApiElements                | |
| | |  '---------------------------'  | | |     |    | |  .------------------------.  | |
| |  '---------------+---------------'  | |     |    | | |dependencies              | | |
|  '-----------------|-----------------'  |     |    | | |  .--------------------.  | | |
|                    |                    |     |    | | | |...                   +---------> ...
|                    |                    |     |    | | |  '--------------------'  | | |
|          inherits dependencies          |     |    | |  '------------------------'  | |
|                    |                    |     |    | |  .------------------------.  | |
|                    |                    |     +----->+ |capabilities              | | |
|  .-----------------|-----------------.  |     |    | | |  .--------------------.  | | |
| |compileClasspath  v                  | |     |    | | | |gizmo:gadget-baz:2.0.0| | | |
| |  .---------------+---------------.  | |     |    | | |  '--------------------'  | | |
| | |dependencies                     +---------+    | |  '------------------------'  | |
| |  '-------------------------------'  | |          |  '----------------------------'  |
|  '-----------------------------------'  |           '--------------------------------'
 '---------------------------------------'
{% endgoat %}
Gradle, it turns out, doesn't actually have any issue with ending up with more than one variant from the same component during resolution! Each dependency must end up mapped to exactly one variant, but the total tree could have multiple from the same component. What Gradle _does_ enforce is that any given _capability_ appears in the resolved tree at most once; since capabilities are a way of expressing "what stuff does this variant contain", this lets you ensure you don't end up with duplicate libraries on the classpath.

{% alert note %}
Gradle enforces uniqueness of capabilities even when the variants come from different modules; this is useful for ensuring that different modules providing the same API conflict with each other. For instance, you might imagine that multiple vendors all produce implementations of the same API, but distribute them under different module identifiers (in their own groups); they can communicate this to consumers by giving their modules' variants an extra capability: some standardized identifier for the API.
{% endalert %}

Adding capabilities to outgoing variants is as simple as adding them to the backing configuration:
```gradle
configurations {
    bazApiElements {
        outgoing {
            capability("gizmo:gadget-baz:2.0.0")
        }
    }
}
```

### Feature variants

When we apply the `java` (or `java-library`) plugin, Gradle sets up a lot of useful stuff for us: it exposes runtime and API transitive dependencies and artifacts via variants, builds a jar, puts the right attributes on all the relevant consumable configurations, and even creates source and javadoc artifacts if we request them. It would be quite convenient if we could get all this set up, but for some other capability than the implicit one. Gradle allows this via _feature variants_:
```gradle
// gizmo:gadget build.gradle

java {
    registerFeature("baz") {
        usingSourceSet(sourceSets.create("baz"))
        withSourcesJar()
    }
}
```

{% alert note %}
The feature name used when you register the feature isn't _quite_ exactly the capability suffix that is published; namely, it's converted from `camelCase` to `kebab-case`. So, `registerFeature("myFeature")` will publish a capability with the suffix `-my-feature`, and other places that refer to the feature name, such as requiring it on a dependency, will use the `kebab-case` form.
{% endalert %}

When we register a feature, Gradle will set up everything needed to publish all the equivalents of the built-in variants, but with a capability derived from the feature name (in this case, `gizmo:gadget-baz`), with the same version as the project. Unlike using a classifier, a feature variant can have its own transitive dependencies; for instance, we can make the `baz` feature depend on the main feature:
```gradle
dependencies {
    bazApi(project(":"))
}
```
Furthermore, Gradle makes requiring "special" capabilities of this form (the module identifier, followed by a feature name) easy:
```gradle
dependencies {
    api("gizmo:gadget:2.0.0") {
        capabilities {
            // This is effectively just sugar for requireCapability("gizmo:gadget-baz")
            requireFeature("baz")
        }
    }
}
```
Feature variants and attributes, combined, allow Gradle to handle the use cases where Maven uses classifiers, but in a way that exposes in the published metadata everything available within a component to consumers.
