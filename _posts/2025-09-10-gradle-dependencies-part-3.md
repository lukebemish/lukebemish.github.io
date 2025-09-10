---
layout: post
title: 'Gradle Dependencies, Part 3: Why Is My Artifact Transform Failing?'
author: Luke Bemish
tag: Gradle Dependencies
---

Previously: [Part 2: Artifacts and Capabilities]({% post_url 2025-08-03-gradle-dependencies-part-2 %})

This is the third part of my series on Gradle's dependency management system. In this post, I will discuss Gradle's artifact transform system, including some common pitfalls of using it and how they may be worked around.

## A mildly misleading example

Previously, I discussed the process of _artifact selection_, in which Gradle picks a set of artifacts given some target variants, as well as third-party artifact selectors, a system by which a dependency may completely override which artifact is picked during artifact selection, meant for supporting Maven-style dependencies involving classifiers or extensions. However, Gradle gives us a more Gradle-ish approach to fine-tuning artifact selection: [artifact transforms](https://docs.gradle.org/9.0.0/userguide/artifact_transforms.html).

Let's follow along with the Gradle docs for a bit to see what's going on here. First, we declare a transform, with a class:
```java
public abstract class MyTransform implements TransformAction<TransformParameters.None> {
    @InputArtifact
    protected abstract Provider<FileSystemLocation> getInputArtifact();

    @Override
    public void transform(TransformOutputs outputs) {
        var inputFile = getInputArtifact().get().getAsFile();
        var outputFile = outputs.file(inputFile.getName().replace(".jar", "-transformed.jar"));
        // Perform transformation logic here
        try (var input = new FileInputStream(inputFile);
             var output = new FileOutputStream(outputFile)) {
            input.transferTo(output);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
```
Transforms are a bit like tasks; they have inputs and outputs, and they perform an action. You can annotate them with `@CacheableTransform` to make them use the build cache, with many of the same requirements using the build cache for a task has. Next, we register the transform with Gradle, noting which attributes it transforms from and to:
```gradle
dependencies {
    registerTransform(MyTransform) {
        from.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "jar")
        to.attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "transformed-jar")
    }
}
```
We see that we're telling Gradle that this transform takes artifacts with the attribute `artifactType=jar` and produces artifacts with the attribute `artifactType=transformed-jar`

{% alert note %}
Hmm, that attribute name looks different from most we've seen... it's a Gradle-built-in attribute, but it isn't in the `org.gradle` namespace. Something is fishy here! We'll get back to that; it turns out that this example is not as nice as it seems.
{% endalert %}

And finally, you request that attribute in the configuration you're resolving:
```gradle
configurations.named("runtimeClasspath") {
    attributes {
        attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "transformed-jar")
    }
}
```

Let's say we have the same dependency tree as earlier:
```
+--- gizmo:gadget:2.0.0
     +--- foo:bar:1.1.0
     \--- bannana:apple:3.0.0
```
And we depend on `gizmo:gadget:2.0.0`. If we inspect the runtime classpath with this transform set up, we see:
```
/<...>/gadget-2.0.0-transformed.jar
/<...>/bar-1.1.0-transformed.jar
/<...>/apple-3.0.0-transformed.jar
```

That's pretty neat! Looks like we can use this to arbitrarily transform artifacts during dependency resolution, just by requesting attributes and registering transforms between attributes, which seems super useful, right? Well... not quite. You see, the example in Gradle's docs is a bit misleading.

Let's try something else to demonstrate: try making this same transform instead between the `org.gradle.usage=java-runtime` and `org.gradle.usage=transformed-runtime` attributes, and requesting the latter:
```gradle
dependencies {
    registerTransform(MyTransform) {
        from.attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, Usage.JAVA_RUNTIME))
        to.attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, "transformed-runtime"))
    }
}

configurations.named("runtimeClasspath") {
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, "transformed-runtime"))
    }
}
```

Now, if we try to look at the runtime classpath, we instead get a variant selection error:
```
> Could not resolve all files for configuration ':runtimeClasspath'.
   > Could not resolve gizmo:gadget:2.0.0.
     Required by:
         root project 'consuming'
      > No matching variant of gizmo:gadget:2.0.0 was found. The consumer was configured to find a library for use during 'transformed-runtime', compatible with Java 21, packaged as a jar, preferably optimized for standard JVMs, and its dependencies declared externally but:
          - Variant 'apiElements' declares a library, compatible with Java 21, packaged as a jar, and its dependencies declared externally:
              - Incompatible because this component declares a component for use during compile-time and the consumer needed a component for use during 'transformed-runtime'
              - Other compatible attribute:
                  - Doesn't say anything about its target Java environment (preferred optimized for standard JVMs)
          - Variant 'runtimeElements' declares a library, compatible with Java 21, packaged as a jar, and its dependencies declared externally:
              - Incompatible because this component declares a component for use during runtime and the consumer needed a component for use during 'transformed-runtime'
              - Other compatible attribute:
                  - Doesn't say anything about its target Java environment (preferred optimized for standard JVMs)
          - Variant 'sourcesElements' declares a component, and its dependencies declared externally:
              - Incompatible because this component declares documentation for use during runtime and the consumer needed a library for use during 'transformed-runtime'
              - Other compatible attributes:
                  - Doesn't say anything about its elements (required them packaged as a jar)
                  - Doesn't say anything about its target Java environment (preferred optimized for standard JVMs)
                  - Doesn't say anything about its target Java version (required compatibility with Java 21)
```

Okay, so what's going on here? The error itself makes some sense: we requested a variant with a collection of attributes, but none of the variants in the component match those. But wait, didn't we register a transform that produces the attribute in question? Why isn't Gradle using it? Why did the first example work but not this?

At this point, we have to remember that artifact transforms work during _artifact_ selection, not variant selection. Variants are selected before artifact transforms are even considered, so for selection to succeed, there has to be a matching variant for whatever attributes are requested. In this case, variant selection fails before artifact selection even begins, because there's no matching variant for the attributes we requested. With this in mind, let's go back to the first example and look at why it succeeded.

We expect resolution here to use a (possibly transformed) version of the artifacts from the `runtimeElements` variant, so let's take a look at that variant:
```
--------------------------------------------------
Variant runtimeElements
--------------------------------------------------
Runtime elements for the 'main' feature.

Capabilities
    - gizmo:gadget:2.0.0 (default capability)
Attributes
    - org.gradle.category            = library
    - org.gradle.dependency.bundling = external
    - org.gradle.jvm.version         = 21
    - org.gradle.libraryelements     = jar
    - org.gradle.usage               = java-runtime
Artifacts
    - build/libs/gadget.jar (artifactType = jar)

```

This variant has the `org.gradle.usage` attribute, and so we get a conflict if we try to resolve `org.gradle.usage=transformed-runtime`; however, it lacks the `artifactType` attribute entirely, so when we select a variant with `artifactType=transformed-jar`, this variant is eligible to be selected. However, for the artifact transform to come into play, the `artifactType` attribute has to pop up at some point; if the artifact lacked it, the transform wouldn't be needed at all, as the artifact would already match the requested attributes (since a lack of an attribute matches any requested value). It turns out that the attributes of a variant considered during variant selection, and the attributes of an _artifact_ of that variant considered during artifact selection, are not actually the same. Most notably, the `artifactType` attribute is added to artifacts, with a value of their `artifactType` (in this case, `jar`). So variant selection picks `runtimeElements`, but then artifact selection notes that the available artifact does not match in the `artifactType` attribute and applies the transform to find a matching artifact.

To use artifact transforms with attributes other than `artifactType` with its special behaviour, we can make use of one of two approaches: attaching default attributes to artifacts based on their artifact type, or using artifact views of a configuration to request different attributes than variant resolution asks for.

## Artifact views

The simplest way to work with artifact transforms is through the use of [artifact views](https://docs.gradle.org/9.0.0/userguide/artifact_views.html). An artifact view allows you to use different attributes during variant selection than during artifact selection. For instance, if we use the earlier example, but let `runtimeClasspath` still request `org.gradle.usage=java-runtime` as normal, we can create an artifact view selecting our transformed artifact with

```gradle
configurations.runtimeClasspath.incoming.artifactView {
    attributes {
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage, "transformed-runtime"))
    }
}
```

This view on `runtimeClasspath` will select the same variants as `runtimeClasspath`, but during artifact selection will request different attributes; in this case, `org.gradle.usage=transformed-runtime`. Note that artifact views are merely a _view_ on a configuration; they do not change the result of resolution in the configuration itself. To use the view in a task input, you may consume the resulting artifact files through `getFiles()`, or information about artifact resolution by the APIs available in `ArtifactCollection`, through `getArtifacts()`.

Artifact views have a couple more tricks up their sleeves, though. The first major trick is that they may be used to allow _variant reselection_. For instance -- in the last case, the resulting artifact still came from the `runtimeElements` variant, it was just transformed. But what if we wanted to select source jars for every dependency instead? We can do this with variant reselection, which lets the resulting artifact come from _any_ variant on the components, without modifying the dependency tree:

```gradle
configurations.runtimeClasspath.incoming.artifactView {
    withVariantReselection()
    attributes {
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category, Category.DOCUMENTATION))
        attribute(DocsType.DOCS_TYPE_ATTRIBUTE, objects.named(DocsType, DocsType.SOURCES))
    }
}
```

Now, when we consume this view, we will get a sources jar for every component in the normal `runtimeClasspath` resolution; `withVariantReselection()` is necessary here because without it, no matching artifact is available, as Gradle would only check the artifacts of the `runtimeElements` variant. Reselection allows it to find the matching artifact of the `sourcesElements` variant instead.

Finally, in this case not every library will have a published sources jar. You might want to find a sources jar for those components that have one, and skip those that don't, without erroring. To make the artifact view behave this way, just add `lenient(true)` to the view's configuration.

## Artifact default attributes

The `artifactType` attribute gets special treatment during artifact selection, as Gradle automatically adds it to every artifact, based on its extension, even though it is not present on the variant: a convenient feature for use with artifact transforms. It turns out that it's possible to link up other attributes besides `artifactType` to this behaviour! For instance, let's imagine we have a `com.example.transformed` attribute, which takes values `true` or `false`. Some published libraries will publish a transformed and non-transformed variant, and we wish to select the `true` variant during selection:

```gradle
var transformedAttribute = Attribute.of("com.example.transformed", Boolean)

configurations.named("runtimeClasspath") {
    attributes {
        attribute(transformedAttribute, true)
    }
}
```

Some libraries, however, are unaware of this attribute and provide only a single jar that hasn't been transformed in the expected way. We can attach a default value for the `com.example.transformed` attribute to all artifacts of `artifactType=jar`; this way, an artifact transform will be used to transform artifacts from unaware components, while components aware of our attribute can publish artifacts with both values:

```gradle
dependencies {
    registerTransform(MyTransform) {
        from.attribute(transformedAttribute, false)
        to.attribute(transformedAttribute, true)
    }
    artifactTypes {
        named("jar") {
            attributes.attribute(transformedAttribute, false)
        }
    }
}
```

This allows us to work with custom attributes and artifact transforms in a similar fashion to how `artifactType` works, by coupling default values for them to artifact types. Note an important caveat though: we will still be unable to resolve an artifact for a component that only provides a variant with `com.example.transformed=false` and none with `com.example.transformed=true`:

```
> Could not resolve all files for configuration ':runtimeClasspath'.
   > Could not resolve gizmo:gadget:2.0.0.
     Required by:
         root project 'consuming'
      > No matching variant of gizmo:gadget:2.0.0 was found. The consumer was configured to find a library for use during runtime, compatible with Java 21, packaged as a jar, preferably optimized for standard JVMs, and its dependencies declared externally, as well as attribute 'com.example.transformed' with value 'true' but:
          - Variant 'notTransformedRuntimeElements' declares a library for use during runtime, compatible with Java 21, packaged as a jar, and its dependencies declared externally:
              - Incompatible because this component declares a component, as well as attribute 'com.example.transformed' with value 'false' and the consumer needed a component, as well as attribute 'com.example.transformed' with value 'true'
              - Other compatible attribute:
                  - Doesn't say anything about its target Java environment (preferred optimized for standard JVMs)
```

This fails during _variant_ selection due to the lack of a matching variant. Components that are entirely unaware proceed to artifact selection because the lack of a value for `com.example.transformed` in all their variants matches any requested value. If your goal is to transform the results of resolution, using an attribute you _didn't_ consider during variant selection, you're likely to be better served by using artifact views instead, at least if you expect anything you consume to have that a value for that variant to begin with. Artifact views let you split out the process of artifact selection from the process of variant selection and request different attributes for each.

_Part 4 hopefully coming soon!_
