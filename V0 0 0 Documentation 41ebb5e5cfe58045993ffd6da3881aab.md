# V0.0.0 Documentation

## Overview

Many modern subscription-based desktop softwares suffer from a similar set of systemic problems. On one hand, greed is rampant. Developers can centralize control, suppress competition, and strategically delay innovation to maximize revenue. On the other hand, incompetency is incentivized. Pressure to market trendy features can lead designers to ship unfinished software while neglecting bugs and long-term improvements. Rushing features without maintainability in mind creates tech debt that makes even simple tasks slow or unreliable. Worst of all, subscription models can leave users without ownership or the ability to customize and improve what they pay for. Nothing is more frustrating than desktop software that is not optimized for the full performance of its hardware.

To address these problems, I envision a free and versatile desktop software platform with a vibrant community plug-in marketplace. The platform should be an easy entry point for beginner software engineers and designers, a safe haven for professionals to learn and grow, and a healthy, competitive environment for experts to build and sell their great ideas.

Fray is meant to be that platform.

## Core Components

Fray has been designed with four core components:

<aside>
<img src="https://app.notion.com/icons/gear_blue.svg" alt="https://app.notion.com/icons/gear_blue.svg" width="40px" />

### Engine (C++)

The Engine, or back-end, is responsible for loading, modifying, and saving Fray’s application state to the disk.

Also responsible for spawning worker threads that manage Engine Plug-ins.

</aside>

<aside>
<img src="https://app.notion.com/icons/gears_gray.svg" alt="https://app.notion.com/icons/gears_gray.svg" width="40px" />

### Engine Plug-in (DLL)

Engine Plug-ins are standardized dynamically-linked libraries that perform complex or computationally-heavy tasks.

</aside>

<aside>
<img src="https://app.notion.com/icons/gear_blue.svg" alt="https://app.notion.com/icons/gear_blue.svg" width="40px" />

### UI (Electron)

The UI, or front-end, is responsible for presenting and updating Fray’s visual interface, as well as capturing user interactions.

Also responsible for spawning worker threads that manage UI Plug-ins.

</aside>

<aside>
<img src="https://app.notion.com/icons/gears_gray.svg" alt="https://app.notion.com/icons/gears_gray.svg" width="40px" />

### UI Plug-in (JSX)

UI Plug-ins are standardized React apps that present the user with visual interface elements and capture user interaction.

</aside>

Generally, there is only one instance of an Engine process and one instance of a UI process. Plug-ins, however, are many; they may operate in a variety of ways with one or more instances, depending on how they are implemented. It is completely normal for Fray to have dozens of processes going at one time.

This is because, architecturally, Fray is [essentially decoupled](../FRAY%2041ebb5e5cfe58072b56ed68c1788d1d1.md), which means that each of these core components operate as independent processes (or detached threads). Rather than acting as one mono-process, Fray is, by-design, a multi-process, multi-threaded desktop application.

Fray’s architecture, however, allows your operating system to do what operating systems do best: manage resources between multiple processes simultaneously.

**Inter-process Communication**

 If and when components need to communicate, they do so via *inter-process communication*.

<aside>
<img src="https://app.notion.com/icons/book-closed_blue.svg" alt="https://app.notion.com/icons/book-closed_blue.svg" width="40px" />

***Inter-process Communication (IPC)***
The set of mechanisms that lets separate processes exchange data and coordinate with one another. In Fray, IPC lets the independent components communicate when needed. Common IPC methods include pipes, sockets, shared memory, and message queues.

</aside>

**Message Queue Threads**

All component processes are responsible for maintaining their own message queue threads. Each must be capable of receiving and sending messages, oftentimes simultaneously. It might help to think of it like each component process having their own individual post office.

In order to maintain [responsiveness](../FRAY%2041ebb5e5cfe58072b56ed68c1788d1d1.md), however, these message queue threads should never be slowed or blocked. Messages should never be serialized, deserialized, or processed on the message queue threads. They must remain fast and continuous. They are optimized for sending and receiving mail, but they will not open your packages for you.

<aside>
<img src="https://app.notion.com/icons/alert_gray.svg" alt="https://app.notion.com/icons/alert_gray.svg" width="40px" />

For plug-in developers, note that message queue threads for plug-ins are automatically implemented on your behalf. Your plug-ins are effectively “wrapped” by a standardized message handler, among other baseline utilities.

What this means for you is that a function pointer to your plug-in entry point will be stored and called on as your plug-in’s incoming message handler.

When your plug-in receives a message, your entry point will be called and handed an `in_dataP` object pointer, which will contain the raw incoming message object among other things. It is then your plug-in’s responsibility to handle that message as required, to include deserializing, processing, and storing.

When your plug-in wants to send a message, that is also largely implemented for you. Both on plug-in initiation and every time your plug-in receives an incoming message, your entry point will be handed an `out_dataP` object pointer, which will provide you with helper functions that you can use to construct and queue outgoing messages.

</aside>

**Messages**

What are messages? They are simple objects with two substructures: a header, which is unserialized, and a payload, which may or may not be serialized. Message headers in Fray are always the same: they include static fields for a message code, source string, destination string, payload size.

[https://app.notion.com](https://app.notion.com)