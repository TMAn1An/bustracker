import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: put these in android/keystore.properties (never commit it) or in environment variables (CI).
val keyProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signing(name: String): String? = keyProps.getProperty(name) ?: System.getenv("ANDROID_" + name.uppercase())

android {
    namespace = "io.github.tman1an.bustracker"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.tman1an.bustracker"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "SITE_URL", "\"${project.property("siteUrl")}\"")
    }

    signingConfigs {
        create("release") {
            val store = signing("storeFile")
            if (store != null) {
                storeFile = file(store)
                storePassword = signing("storePassword")
                keyAlias = signing("keyAlias")
                keyPassword = signing("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signing("storeFile") != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
