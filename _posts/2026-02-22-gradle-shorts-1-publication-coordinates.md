---
layout: post
title: 'Gradle Dependency Resolution Shorts: Publication Coordinates'
author: Luke Bemish
categories:
  - Gradle Dependencies
---

I figured I would try a slightly shorter form of post this time; I'll be covering a few smaller quirks of Gradle dependency
resolution that I've ran into that don't necessarily warrant a full post but are interesting enough to share. First off:
Gradle's publication API can lead to unpleasant side effects if you modify the coordinates of a published component to not
match the project-derived coordinates.

Publishing for a Gradle project normally looks something like:

```groovy
// build.gradle for :foo

plugins {
    id 'java-library'
    id "maven-publish"
}

group = "org.example"
version = "1.0.0"

publishing {
    publications {
        maven(MavenPublication) {
            from components.java
        }
    }
}
```
This publishes a single component at coordinates determined by the name, group and version of the project itself. The
component (here `components.java`) has a number of variants attached to it, which are published and used to create the
published component metadata.

However, the publishing API also lets you manually set up the coordinates that a publication will be published with, and add
artifacts to it manually instead of using the `from components` syntax. Doing the latter results in less rich metadata and 
encourages the use of classifiers in dependencies which I've already [discussed the issues with elsewhere]({% post_url 2025-08-03-artifacts-capabilities %}#why-artifact-selectors-sorta-suck), but it turns out that the former can be a bit dangerous too! To see why, consider the
following example. We have one project, `:foo`, which publishes a component with coordinates modified by setting the `artifactId`
property on the publication, and a second project, `:bar`, which depends on `:foo` and is also published:

```groovy
// build.gradle for :foo
plugins {
    id 'java-library'
    id 'maven-publish'
}

group = 'org.example'
version = '1.0.0'

publishing {
    publications {
        mavenJava(MavenPublication) {
            from components.java
            artifactId = 'not-foo'
        }
    }
}
```

```groovy
// build.gradle for :bar
plugins {
    id 'java-library'
    id 'maven-publish'
}

group = 'org.example'
version = '1.0.0'

dependencies {
    api project(':foo')
}

publishing {
    publications {
        mavenJava(MavenPublication) {
            from components.java
        }
    }
}
```

When module metadata for `:bar` is published, it needs to publish a dependency on `:foo` with the correct coordinates. However,
for the resulting metadata to match where `:foo` is published, the module metadata would need to have a dependency on
`org.example:not-foo:1.0.0`, which requires Gradle to look at `:foo`'s publication when resolving the dependencies of `:bar`.

Gradle does this, it turns out, and the previous buildscripts work sensibly and publish dependencies that work for consumers!
However, this has some unpleasant side effects. The following inspects the results of dependency resolution for
`:bar` and looks at the capabilities of the dependency on `:foo`:

```groovy
// build.gradle for :bar
tasks.register('printCapabilities') {
    def capabilities = configurations.compileClasspath.incoming
            .resolutionResult.rootComponent.map {
        it.dependencies.collectMany {
            (it as ResolvedDependencyResult)
                .resolvedVariant.capabilities
        }
    }
    doLast {
        println capabilities.get()
    }
}
```

If we run this, we get:

```
[capability group='org.example', name='foo', version='1.0.0']
```

Which is... not awesome, because it means that if we're trying to reason about the capabilities of dependencies based on the
resolution result, those might differ from the capabilities of actual transitive dependencies we will be publishing, at
least if they're implicit capabilities based on the module coordinates!

What if we don't use the publication-with-custom-coordinates as the "main" publication, but instead try and publish two
different components from the same project? Say, to make a feature variant accessible nicely from maven by publishing it as a
module at the coordinates of its capability. We might start with something like:

```groovy
// build.gradle for :foo
publishing {
    def other = softwareComponentFactory.adhoc('other')
    publications {
        mavenJava(MavenPublication) {
            from components.java
        }
        mavenOther(MavenPublication) {
            from other
            artifactId = 'not-foo'
        }
    }
}
```

As soon as we try and publish `:bar` with this though, we'll get a fun error:

```
Execution failed for task ':bar:generateMetadataFileForMavenJavaPublication'.
> Publishing is not able to resolve a dependency on a project with multiple publications that have different coordinates.
  Found the following publications in project ':foo':
    - Maven publication 'mavenJava' with coordinates org.example:foo:1.0.0
    - Maven publication 'mavenOther' with coordinates org.example:not-foo:1.0.0
```

Gradle doesn't let us publish a dependency on a project with more than one published component.

In general, these types of issues can be avoided by not using `MavenPublication#setArtifactId`, `MavenPublication#setGroupId`,
or `MavenPublication#setVersion` and by treating projects and components as having a one-to-one relationship, using project
name, group, and version exclusively to determine the component coordinates.