---
layout: post
title: 'Custom Repository Metadata Formats, or, PyPI in Gradle'
author: Luke Bemish
gravatar: lukebemish@lukebemish.dev
categories:
  - Gradle Dependencies
redirect_from:
    - /2025/09/14/gradle-dependencies-part-4
---

Gradle only natively supports a few dependency metadata formats. Tools like component metadata rules, ivy pattern layouts, and component version listers can be combined to handle metadata and repositories in other formats in a way Gradle can understand.

## Dependency metadata formats

When Gradle fetches a component from a repository, it supports 4 formats for determining the metadata of that component:
- Maven POM files
- Ivy XML files
- Gradle's own module metadata files
- "Artifact" metadata, where all metadata is inferred from the existence of a single target artifact

All of these are converted into something resembling Gradle's module metadata format internally; while the metadata format
used varies based on the repository type, it can also be configured manually using `metadataSources` on a repository:

```gradle
repositories {
    ivy {
        url = uri("https://example.com/ivy-repo")
        metadataSources {
            // Use only Gradle's module metadata format
            gradleMetadata()
        }
    }
}
```

{% alert note %}
The `ivy` repository type is by far the most flexible within Gradle; in fact, you can even specify maven repositories as special ivy repositories of a sort. For this reason I'll be using `ivy` repositories throughout this example; note that you don't actually need to know anything about ivy for this.
{% endalert %}

Gradle has no native system for supporting repository layouts other than `ivy` and `maven`, nor any system for supporting metadata formats other that those listed above. Or, at least, not directly. It turns out that with some creativity, Gradle gives us the right toolbox to do this, however!

For this post, I've picked an example of a metadata format Gradle doesn't natively support: PyPI packages. [PyPI](https://pypi.org/), or the Python Package Index, is a repository of Python packages. Packages have dependencies, versions, and potentially multiple possible sets of artifacts or dependencies per version (e.g. for different platforms, or different Python versions). Overall, though, there's nothing that _shouldn't_ be possible to map onto Gradle's dependency model, if we use some creativity.

{% alert note %}
In the last few blog posts, the examples have mostly been in Groovy, as if they were in a buildscript; this post will include mostly examples written in Java, though, as if this were a Gradle plugin. The corresponding code is available on [GitHub](https://github.com/lukebemish/pypi-in-gradle-demo).
{% endalert %}

## Building a custom format

Let's start out by figuring out the basics of how we're going to express PyPI metadata in Gradle. We'll want attributes for architecture and operating system (Python's dependency requirement system allows a few more types of context than this but we'll ignore the others for simplicity's sake). We'll use the built-in `org.gradle.native.operatingSystem` and `org.gradle.native.architecture` attributes for these.

As well as some more utilities for working with PyPI's metadata:
- A way of parsing PyPI version constraints (aka, things like `urllib3<3,>=1.21.1`)
- Tools for parsing the results of querying PyPI's JSON API
- Various other utilities for working with Python versions, and parsing them into versions that may be compared with Gradle's version comparison system

I'm not going to go into the details of all that here, since it's not the focus of the post, but it's all on the GitHub for those curious. Next, we need to look at where the metadata and artifacts are actually coming _from_. From [the docs on the PyPI API](https://docs.pypi.org/api/json/), we can acquire metadata about a version of a package by fetching `https://pypi.org/pypi/<package>/<version>/json` (for instance, `https://pypi.org/pypi/requests/2.32.5/json`). We'll use the `artifact` metadata source to make each package metadata into a component, and then use metadata rules to fix up the metadata after the fact. For this simplified example, we'll want to pay attention to the following parts of the API response:
- `info.requires_dist` which lists dependencies of the package, in Python's dependency format
- `urls`, which contains information about the artifacts available for this package version. We are primarily interested in files of two `packagetype`s:
  - `bdist_wheel`, which contain pre-built binary distributions as `.whl` files
  - `sdist`, which are source distributions as `.tar.gz` files

{% alert note %}
Some PyPI packages make use of "extras", ways of specifying special sets of dependencies pulled in. The environment marker system also supports plenty more attributes than I address here. This example is meant as a proof-of-concept, and demonstration of the general approach for mapping foreign metadata onto Gradle; while you could imagine representing the "extra" data with capabilities, or implementing attributes for the rest of the environment markers and supporting the full grammar of the dependency specifiers, I haven't done so here for brevity.
{% endalert %}

### Ivy layout patterns

Ivy repositories support layouts besides the "default" ivy or maven layout. This allows us to specify how to turn a module component identifier (or even a maven GAV) into a path within the repository. In this case, we'll make a repository like the following:

```java
project.getRepositories().exclusiveContent(exclusive -> {
    exclusive.forRepositories(project.getRepositories().ivy(repository -> {
        repository.setUrl("https://pypi.org/pypi/");
        repository.patternLayout(layout -> {
            layout.artifact("[module]/[revision]/json");
        });
        repository.metadataSources(sources -> {
            sources.artifact();
        });
    }));
    exclusive.filter(content -> {
        content.includeGroup("pypi");
    });
});
```

This repository:
- is an ivy repository based off the root PyPI URL, `https://pypi.org/pypi/`
- uses a pattern layout to locate _all_ artifacts to be at `[module]/[revision]/json`, which means that any artifact for `pypi:requests:2.32.5` will be at `https://pypi.org/pypi/requests/2.32.5/json`
- uses only artifact metadata, meaning that to find a component, Gradle will just look for an artifact at the URL specified by the pattern layout.
- is only used for components in the `pypi` group

With this, you can depend on `pypi:requests:2.32.5`; Gradle will fetch `https://pypi.org/pypi/requests/2.32.5/json`, and create a component with a single variant, that contains the fetched JSON file as its artifact. Except that Gradle treats it as a `.jar` file, as that's the default artifact type. We'll fix that later! At least now we can map module component identifiers to PyPI packages, in a way that can determine whether those packages exist.

The URLs for artifacts of PyPI packages point to locations within `https://files.pythonhosted.org/packages/`; this will cause some slight complexity for us. Repositories that Gradle normally works with generally have one URL, but we need to deal with stuff on more than one domain. Ivy repositories can do this, using different domains for the metadata pattern and the artifact pattern; however, by using the `artifact` metadata source we've already required that the artifact pattern use the `https://pypi.org/`-based URL. We'll solve this down the road with a second repository.

### Fixing the metadata

Next up, we need to fix the metadata of our components. We'll use a `ComponentMetadataRule` to do this; to access the JSON metadata file from within the rule, we can use a `RepositoryResourceAccessor`, which is a special service that may be injected in component rules and can fetch files from the repository sourcing the component the rule is running on:

```java
@CacheableRule
public abstract class PyPIComponentRule implements ComponentMetadataRule {
    @Inject
    public PyPIComponentRule() {}
    
    @Inject
    protected abstract RepositoryResourceAccessor getResources();
    
    @Inject
    protected abstract ObjectFactory getObjects();
    
    @Override
    public void execute(ComponentMetadataContext context) {
        var details = context.getDetails();
        var id = details.getId();
        if (!"pypi".equals(id.getGroup())) {
            return;
        }
        //...
    }
}

//...
project.getDependencies().getComponents().all(PyPIComponentRule.class);
```

Component rules can only be applied to single modules, or to everything; since we need to apply this rule to everything in the `pypi` group, we just apply it to everything and then return early if the group doesn't match. We inject a couple services we'll need: `ObjectFactory` to create `Named` instances when setting up attributes, and `RepositoryResourceAccessor` to fetch the JSON metadata file from within the component rule.

Currently, the metadata contains a single variant, `runtime`, with a single artifact (pointing to the JSON file) and no attributes. We can't remove variants in a component metadata rule, so we'll need to reuse this one as one of our final variants. First, let's remove the artifact:

```java
details.withVariant("runtime", v -> {
    v.withFiles(MutableVariantFilesMetadata::removeAllFiles);
});
```

To actually retrieve the metadata within the rule, we can use the `RepositoryResourceAccessor` with the same path, relative to the repository URL, as we'd expect. Then, the next step is to attach the dependency metadata to variants on the component. I did this by creating a new variant for each OS/architecture combination (except for a single combination which reuses `runtime`), for both source and binary distributions (the `TargetVariant` class in the below example is a utility for handling the target platforms and their variant names). Then, for each dependency, I find which platforms it should be used on, and add it on each of those platforms:

```java
getResources().withResource(String.format("%s/%s/json", id.getName(), id.getVersion()), is -> {
    var metadata = PyPIMetadata.fromJson(is);
    metadata.info().parsedRequirements().forEach(requirement -> {
        for (var target : TargetVariant.matching(requirement.operatingSystemFamily(), requirement.machineArchitecture())) {
            Action<VariantMetadata> addDependencies = v -> {
                v.withDependencies(dependencies -> {
                    dependencies.add("pypi:"+requirement.name(), dep -> dep.version(version -> {
                        if (requirement.versionSpec() != null) {
                            requirement.versionSpec().constraints().apply(version);
                        } else {
                            version.strictly("+");
                        }
                    }));
                });
            };
            details.withVariant(target.variantName(true), addDependencies);
            details.withVariant(target.variantName(false), addDependencies);
        }
    });
    //...
});
```

As noted, I've skipped over all the boring details of parsing the metadata, translating python version ranges into gradle version ranges, and so forth (though if you're curious, my implementation is available on the [GitHub repo](https://github.com/lukebemish/pypi-in-gradle-demo)). The general idea here is to attach the necessary dependencies to each variant based on the metadata; the version ranges are turned into `strictly` version ranges, as the version ranges in PyPI's metadata represent exact versions that the transitive dependencies must match, not ranges that could possibly be upgraded.

{% alert note %}
Why do I have separate variants set up for the source distributions for each platform when the actual source is platform-independent? Well, while the artifact is the same for each of those, the transitive dependencies may be platform-specific. This wouldn't be necessary if you decided that the source distribution shouldn't expose its transitive dependencies, instead, like java sources jars normally are.
{% endalert %}

Let's try resolving a dependency now! I chose to map the `sdist` vs `bdist_wheel` distinction first and foremost by using `org.gradle.category`, so we'll resolve `pypi:requests:2.32.5` with the attributes
- `org.gradle.native.operatingSystem=linux`
- `org.gradle.native.architecture=x86_64`
- `org.gradle.category=library`

to get `bdist_wheel` distributions for x86_64 Linux, and we see that it resolves a dependency tree as follows:
```
packages
\--- pypi:requests:2.32.5
     +--- pypi:charset_normalizer:{strictly [2,4)} FAILED
     +--- pypi:idna:{strictly [2.5,4)} FAILED
     +--- pypi:urllib3:{strictly [1.21.1,3)} FAILED
     \--- pypi:certifi:{strictly [2017.4.17,)} FAILED
```

Well, that's progress! Two issues remain: first, we haven't actually attached any artifacts to the variants. And secondly, the transitive dependencies all seem to fail. Let's start by attaching those artifacts; we'll come back to why the transitive dependencies are failing (and how to fix that!) in a moment. To attach the artifacts, we first need to figure out how to tell Gradle to resolve artifacts located at `https://files.pythonhosted.org/packages`. We can't just attach the files "normally", since they have a different URL root than our repository and Gradle doesn't allow components to have artifacts in different repositories, but we _can_ make a new repository for artifacts, and then have our variants depend on simple dependencies, located on that repository, that point to the actual artifacts. In effect, the artifacts will be pulled in as artifacts of transitive dependencies instead of directly. So, let's add a second repository for this:

```java
project.getRepositories().exclusiveContent(exclusive -> {
    exclusive.forRepositories(project.getRepositories().ivy(repository -> {
        repository.setUrl("https://files.pythonhosted.org/packages");
        repository.patternLayout(layout -> {
            layout.artifact("[module].[ext]");
        });
        repository.metadataSources(sources -> {
            sources.artifact();
        });
    }));
    exclusive.filter(content -> {
        content.includeGroup("org.files.pythonhosted");
    });
});
```
Now, a dep on `org.files.pythonhosted:<path>:<version>` with an artifact selector for the proper extension will resolve to the correct file. The use of `[ext]` and the extension artifact selector (usually [not a great pattern]({% post_url 2025-08-03-artifacts-capabilities %}#why-artifact-selectors-sorta-suck)) is necessary here because when using `artifact` metadata, Gradle determines the artifact type of the artifacts of the generated variant purely from the extension used to _search_ for the artifact, which by default is `.jar`, so we need to specify this explicitly.

It turns out that component rules throw another wrench in the works here; at the time of this writing, in Gradle 9.0.0, you [cannot specify artifact selectors on dependencies added in component rules](https://github.com/gradle/gradle/issues/31867). However, we can work around this with _another_ dummy dependency group, using a dependency rule to extract the extension from the module name and apply it as an artifact selector:

```java
public static final String EXTRACT_EXTENSION_PREFIX = "_extract-extension.";

//...
project.getConfigurations().configureEach(config -> {
    config.getResolutionStrategy().eachDependency(details -> {
        if (details.getRequested().getGroup().startsWith(EXTRACT_EXTENSION_PREFIX)) {
            var name = details.getRequested().getName();
            String extension;
            if (name.endsWith(".tar.gz")) {
                extension = "tar.gz";
            } else {
                var lastIndex = name.lastIndexOf('.');
                extension = name.substring(lastIndex + 1);
                name = name.substring(0, lastIndex);
            }
            details.useTarget(String.format(
                    "%s:%s:%s",
                    details.getRequested().getGroup().substring(EXTRACT_EXTENSION_PREFIX.length()),
                    name,
                    details.getRequested().getVersion()
            ));
            details.artifactSelection(selection -> {
                selection.selectArtifact(extension, extension, null);
            });
        }
    });
});
```

The special logic for `tar.gz` is just to treat its wacky double-extension somewhat nicely. Our component rule can add dependencies on `_extract-extension.org.files.pythonhosted:<path>:<version>` and the artifact selector will be set up properly:

```java
private static final String URL_PREFIX = "https://files.pythonhosted.org/packages/";

//...
getResources().withResource(String.format("%s/%s/json", id.getName(), id.getVersion()), is -> {
    var metadata = PyPIMetadata.fromJson(is);

    //...
    metadata.parsedUrlInfo(id).forEach(info -> {
        for (var target : TargetVariant.matching(info.operatingSystemFamily(id), info.machineArchitecture(id))) {
            Action<VariantMetadata> addFile = v -> {
                v.withDependencies(dependencies -> {
                    if (dependencies.stream().anyMatch(it -> it.getGroup().startsWith(EXTRACT_EXTENSION_PREFIX))) {
                        return; // Attach only the first matching artifact to each platform
                    }
                    if (!info.url().startsWith(URL_PREFIX)) {
                        throw new IllegalStateException("Unexpected URL: " + info.url());
                    }
                    var rest = info.url().substring(URL_PREFIX.length());
                    dependencies.add(EXTRACT_EXTENSION_PREFIX+"org.files.pythonhosted:"+rest+":"+id.getVersion());
                });
            };
            if (info.packageType().equals("bdist_wheel")) {
                details.withVariant(target.variantName(true), addFile);
            } else if (info.packageType().equals("sdist")) {
                details.withVariant(target.variantName(false), addFile);
            }
        }
    });
});
```

{% alert note %}
Plenty of PyPI packages have different artifacts for different Python versions. To handle this properly, you'd want to add an attribute representing the target python version, in some form, and then create variants for the different provided versions. This is once again skipped here for the sake of brevity, and I instead just only attach the first matching artifact I find for each platform.
{% endalert %}

Now, if we resolve a dependency on this package (excluding any failing `pypi` transitive dependencies for now), we see that it properly resolves the expected `.whl` file.

### Handling version ranges

Transitive dependencies don't seem to be resolving correctly. However, if you pin any of them to a specific version, it will resolve just fine; the root issue here is the use of dependency ranges, because while we've made Gradle aware of the metadata for individual components we haven't given it a way of seeing what versions of a component are available, to pick one satisfying the range. We can provide this by attaching a `ComponentMetadataVersionLister` to the `https://pypi.org/pypi/` repository, and querying the PyPI API from within there using an injected `RepositoryResourceAccessor` as before:

```java
repository.setComponentVersionsLister(PyPIComponentVersionLister.class);

//...
public abstract class PyPIComponentVersionLister implements ComponentMetadataVersionLister {
    @Inject
    public PyPIComponentVersionLister() {}

    @Inject
    protected abstract RepositoryResourceAccessor getResources();
    
    @Override
    public void execute(ComponentMetadataListerDetails details) {
        var name = details.getModuleIdentifier().getName();
        getResources().withResource(String.format("%s/json", name), is -> {
            var metadata = PyPIIndexMetadata.fromJson(is);
            details.listed(metadata.releases().keySet().stream().toList());
        });
    }
}
```

With this, resolution of `pypi:requests:2.32.5` now properly resolves all its transitive dependencies as well:

```
\--- pypi:requests:2.32.5
     +--- pypi:charset_normalizer:{strictly [2,4)} -> 3.4.3
     |    \--- _extract-extension.org.files.pythonhosted:<...>/charset_normalizer-<...>.whl:3.4.3 -> org.files.pythonhosted:<...>/charset_normalizer-<...>:3.4.3
     +--- pypi:idna:{strictly [2.5,4)} -> 3.10
     |    \--- _extract-extension.org.files.pythonhosted:<...>/idna-<...>.whl:3.10 -> org.files.pythonhosted:<...>/idna-<...>:3.10
     +--- pypi:urllib3:{strictly [1.21.1,3)} -> 2.5.0
     |    \--- _extract-extension.org.files.pythonhosted:<...>/urllib3-<...>.whl:2.5.0 -> org.files.pythonhosted:<...>/urllib3-<...>:2.5.0
     +--- pypi:certifi:{strictly [2017.4.17,)} -> 2025.8.3
     |    \--- _extract-extension.org.files.pythonhosted:<...>/certifi-<...>.whl:2025.8.3 -> org.files.pythonhosted:<...>/certifi-<...>:2025.8.3
     \--- _extract-extension.org.files.pythonhosted:<...>/requests-<...>.whl:2.32.5 -> org.files.pythonhosted:<...>/requests-<...>:2.32.5
```

If we inspect the resolved files, we see that they are all the expected `.whl` files for x86_64 Linux:
```
/<...>/requests-2.32.5-py3-none-any-2.32.5.whl
/<...>/charset_normalizer-3.4.3-cp310-cp310-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64-3.4.3.whl
/<...>/idna-3.10-py3-none-any-3.10.whl
/<...>/urllib3-2.5.0-py3-none-any-2.5.0.whl
/<...>/certifi-2025.8.3-py3-none-any-2025.8.3.whl
```

Now, obviously I picked a particularly wacky example here; in practice, you're unlikely to be consuming PyPI packages with Gradle (seeing as Python has plenty of package-management systems of its own). However, this general approach can be used to consume any foreign metadata format in a Gradle build, and its constituent parts are quite useful for fixing up dependency metadata in general.