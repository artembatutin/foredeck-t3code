import Foundation
import T3CodeCommunication

public protocol PairingCodeValidating: AnyObject {
    func validate(_ code: String) -> Bool
}

public protocol TokenGenerating {
    func makeToken() -> String
}

public struct RandomTokenGenerator: TokenGenerating {
    public init() {}

    public func makeToken() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
}

public struct RequestOutcome: Equatable, Sendable {
    public let accepted: Bool
    public let errorCode: String?

    public init(accepted: Bool, errorCode: String?) {
        self.accepted = accepted
        self.errorCode = errorCode
    }
}

public final class LogicalSession {
    public let id: UUID
    public var resumeToken: String
    public var activeConnectionID: UUID?
    public var nextServerSequence: UInt64
    public var lastAppliedClientSequence: UInt64
    public var lastAppliedServerSequenceByClient: UInt64
    public var lastSeenAt: Date

    private(set) var replayBuffer: [Envelope]
    private(set) var completedRequests: [UUID: RequestOutcome]

    public init(
        id: UUID = UUID(),
        resumeToken: String,
        nextServerSequence: UInt64 = 1,
        lastSeenAt: Date = Date()
    ) {
        self.id = id
        self.resumeToken = resumeToken
        self.nextServerSequence = nextServerSequence
        self.lastAppliedClientSequence = 0
        self.lastAppliedServerSequenceByClient = 0
        self.lastSeenAt = lastSeenAt
        self.replayBuffer = []
        self.completedRequests = [:]
    }

    public func makeServerSequence() -> UInt64 {
        defer { nextServerSequence += 1 }
        return nextServerSequence
    }

    public func appendReplayable(_ envelope: Envelope) {
        replayBuffer.append(envelope)
        replayBuffer = Array(replayBuffer.suffix(ProtocolConfig.replayBufferLimit))
    }

    public func markCompleted(requestID: UUID, outcome: RequestOutcome) {
        completedRequests[requestID] = outcome
    }

    public func outcome(for requestID: UUID) -> RequestOutcome? {
        completedRequests[requestID]
    }
}

public enum HostAction: Equatable, Sendable {
    case send(connectionID: UUID, envelope: Envelope)
    case closeConnection(UUID)
    case routePrompt(sessionID: UUID, request: PromptRequest)
    case routeCodeEdit(sessionID: UUID, edit: CodeEdit)
    case routeExecution(sessionID: UUID, command: ExecutionCommand)
}

public final class HostSessionCoordinator {
    private let pairingValidator: any PairingCodeValidating
    private let tokenGenerator: any TokenGenerating
    private let serverName: String
    private let resumeWindow: TimeInterval

    private var sessions: [UUID: LogicalSession]
    private var activeSessionID: UUID?
    private var connectionToSessionID: [UUID: UUID]

    public init(
        pairingValidator: any PairingCodeValidating,
        tokenGenerator: any TokenGenerating = RandomTokenGenerator(),
        serverName: String,
        resumeWindow: TimeInterval = 10 * 60,
        sessions: [UUID: LogicalSession] = [:]
    ) {
        self.pairingValidator = pairingValidator
        self.tokenGenerator = tokenGenerator
        self.serverName = serverName
        self.resumeWindow = resumeWindow
        self.sessions = sessions
        self.connectionToSessionID = [:]
    }

    public func receive(_ envelope: Envelope, from connectionID: UUID, now: Date = Date()) throws -> [HostAction] {
        purgeExpiredSessions(now: now)

        if let session = session(for: connectionID) {
            session.lastAppliedClientSequence = max(session.lastAppliedClientSequence, envelope.sequence)
            if let acknowledged = envelope.acknowledgesRemoteSequence {
                session.lastAppliedServerSequenceByClient = max(session.lastAppliedServerSequenceByClient, acknowledged)
            }
            session.lastSeenAt = now
        } else {
            switch envelope.body {
            case .hello, .resume:
                break
            default:
                return try [
                    .send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .error(ProtocolError(code: "unauthenticated", message: "Handshake required before commands", recoverable: false)))),
                    .closeConnection(connectionID)
                ]
            }
        }

        switch envelope.body {
        case .hello(let hello):
            return try handleHello(hello, from: connectionID, now: now)
        case .resume(let resume):
            return try handleResume(resume, from: connectionID, now: now)
        case .promptRequest(let request):
            return try handlePrompt(request, from: connectionID)
        case .codeEdit(let edit):
            return try handleCodeEdit(edit, from: connectionID)
        case .executionCommand(let command):
            return try handleExecution(command, from: connectionID)
        case .ping:
            guard let session = session(for: connectionID) else { return [] }
            return try [.send(connectionID: connectionID, envelope: makeEnvelope(session: session, body: .pong(Pong())))]
        default:
            guard let session = session(for: connectionID) else { return [] }
            return try [.send(connectionID: connectionID, envelope: makeEnvelope(session: session, body: .error(ProtocolError(code: "unexpected_message", message: "Unexpected message for host", recoverable: false))))]
        }
    }

    public func detach(connectionID: UUID, now: Date = Date()) {
        guard let sessionID = connectionToSessionID.removeValue(forKey: connectionID), let session = sessions[sessionID] else {
            return
        }

        if session.activeConnectionID == connectionID {
            session.activeConnectionID = nil
            session.lastSeenAt = now
        }

        if activeSessionID == session.id {
            activeSessionID = nil
        }
    }

    public func makeServerStreamStart(_ start: StreamStart, to sessionID: UUID, now: Date = Date()) throws -> HostAction? {
        try makeReplayableServerAction(body: .streamStart(start), sessionID: sessionID, now: now)
    }

    public func makeServerStreamChunk(_ chunk: StreamChunk, to sessionID: UUID, now: Date = Date()) throws -> HostAction? {
        try makeReplayableServerAction(body: .streamChunk(chunk), sessionID: sessionID, now: now)
    }

    public func makeServerStreamEnd(_ end: StreamEnd, to sessionID: UUID, now: Date = Date()) throws -> HostAction? {
        try makeReplayableServerAction(body: .streamEnd(end), sessionID: sessionID, now: now)
    }

    public func session(id: UUID) -> LogicalSession? {
        sessions[id]
    }

    private func handleHello(_ hello: Hello, from connectionID: UUID, now: Date) throws -> [HostAction] {
        guard hello.protocolVersion == ProtocolConfig.version else {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .helloAck(HelloAck(accepted: false, sessionID: nil, resumeToken: nil, serverName: serverName, heartbeatIntervalMs: 0, reason: "unsupported_version"))))]
        }

        guard pairingValidator.validate(hello.pairingCode) else {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .helloAck(HelloAck(accepted: false, sessionID: nil, resumeToken: nil, serverName: serverName, heartbeatIntervalMs: 0, reason: "pairing_failed"))))]
        }

        guard !isBusy(excluding: nil) else {
            return try busyActions(for: connectionID)
        }

        let session = LogicalSession(resumeToken: tokenGenerator.makeToken(), lastSeenAt: now)
        attach(session, to: connectionID, now: now)

        return try [
            .send(
                connectionID: connectionID,
                envelope: makeEnvelope(
                    session: session,
                    body: .helloAck(
                        HelloAck(
                            accepted: true,
                            sessionID: session.id,
                            resumeToken: session.resumeToken,
                            serverName: serverName,
                            heartbeatIntervalMs: ProtocolConfig.heartbeatIntervalMs,
                            reason: nil
                        )
                    )
                )
            )
        ]
    }

    private func handleResume(_ resume: Resume, from connectionID: UUID, now: Date) throws -> [HostAction] {
        guard resume.protocolVersion == ProtocolConfig.version else {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .resumeAck(ResumeAck(accepted: false, replayFromSequence: nil, heartbeatIntervalMs: 0, reason: "unsupported_version"))))]
        }

        guard let session = sessions[resume.sessionID] else {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .resumeAck(ResumeAck(accepted: false, replayFromSequence: nil, heartbeatIntervalMs: 0, reason: "unknown_session"))))]
        }

        guard session.resumeToken == resume.resumeToken else {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .resumeAck(ResumeAck(accepted: false, replayFromSequence: nil, heartbeatIntervalMs: 0, reason: "invalid_resume_token"))))]
        }

        guard !isBusy(excluding: session.id) else {
            return try busyActions(for: connectionID)
        }

        if let oldestReplaySequence = session.replayBuffer.first?.sequence,
           resume.lastAppliedServerSequence + 1 < oldestReplaySequence {
            return try [.send(connectionID: connectionID, envelope: makeUnauthenticatedEnvelope(body: .resumeAck(ResumeAck(accepted: false, replayFromSequence: nil, heartbeatIntervalMs: 0, reason: "replay_gap"))))]
        }

        attach(session, to: connectionID, now: now)
        session.lastAppliedServerSequenceByClient = resume.lastAppliedServerSequence

        var actions: [HostAction] = [
            .send(
                connectionID: connectionID,
                envelope: try makeEnvelope(
                    session: session,
                    body: .resumeAck(
                        ResumeAck(
                            accepted: true,
                            replayFromSequence: resume.lastAppliedServerSequence + 1,
                            heartbeatIntervalMs: ProtocolConfig.heartbeatIntervalMs,
                            reason: nil
                        )
                    )
                )
            )
        ]

        for buffered in session.replayBuffer where buffered.sequence > resume.lastAppliedServerSequence {
            actions.append(.send(connectionID: connectionID, envelope: buffered))
        }

        return actions
    }

    private func handlePrompt(_ request: PromptRequest, from connectionID: UUID) throws -> [HostAction] {
        try handleRequest(requestID: request.requestID, from: connectionID) { session in
            .routePrompt(sessionID: session.id, request: request)
        }
    }

    private func handleCodeEdit(_ edit: CodeEdit, from connectionID: UUID) throws -> [HostAction] {
        try handleRequest(requestID: edit.requestID, from: connectionID) { session in
            .routeCodeEdit(sessionID: session.id, edit: edit)
        }
    }

    private func handleExecution(_ command: ExecutionCommand, from connectionID: UUID) throws -> [HostAction] {
        try handleRequest(requestID: command.requestID, from: connectionID) { session in
            .routeExecution(sessionID: session.id, command: command)
        }
    }

    private func handleRequest(
        requestID: UUID,
        from connectionID: UUID,
        route: (LogicalSession) -> HostAction
    ) throws -> [HostAction] {
        guard let session = session(for: connectionID) else {
            return []
        }

        if let prior = session.outcome(for: requestID) {
            return try [
                .send(
                    connectionID: connectionID,
                    envelope: makeEnvelope(
                        session: session,
                        body: .requestAck(RequestAck(requestID: requestID, accepted: prior.accepted, reason: prior.errorCode))
                    )
                )
            ]
        }

        session.markCompleted(requestID: requestID, outcome: RequestOutcome(accepted: true, errorCode: nil))
        return try [
            .send(
                connectionID: connectionID,
                envelope: makeEnvelope(
                    session: session,
                    body: .requestAck(RequestAck(requestID: requestID, accepted: true, reason: nil))
                )
            ),
            route(session)
        ]
    }

    private func makeReplayableServerAction(body: Body, sessionID: UUID, now: Date) throws -> HostAction? {
        guard let session = sessions[sessionID] else {
            return nil
        }

        session.lastSeenAt = now
        let envelope = try makeEnvelope(session: session, body: body, replayable: true)
        guard let connectionID = session.activeConnectionID else {
            return nil
        }
        return .send(connectionID: connectionID, envelope: envelope)
    }

    private func makeEnvelope(session: LogicalSession, body: Body, replayable: Bool = false) throws -> Envelope {
        let envelope = try Envelope(
            sessionID: session.id,
            sequence: session.makeServerSequence(),
            acknowledgesRemoteSequence: session.lastAppliedClientSequence,
            body: body
        )
        if replayable {
            session.appendReplayable(envelope)
        }
        return envelope
    }

    private func makeUnauthenticatedEnvelope(body: Body) throws -> Envelope {
        try Envelope(sessionID: nil, sequence: 0, body: body)
    }

    private func attach(_ session: LogicalSession, to connectionID: UUID, now: Date) {
        if let previousConnectionID = session.activeConnectionID {
            connectionToSessionID.removeValue(forKey: previousConnectionID)
        }

        session.activeConnectionID = connectionID
        session.lastSeenAt = now
        sessions[session.id] = session
        connectionToSessionID[connectionID] = session.id
        activeSessionID = session.id
    }

    private func session(for connectionID: UUID) -> LogicalSession? {
        guard let sessionID = connectionToSessionID[connectionID] else {
            return nil
        }
        return sessions[sessionID]
    }

    private func isBusy(excluding sessionID: UUID?) -> Bool {
        guard let activeSessionID, let activeSession = sessions[activeSessionID] else {
            return false
        }

        if let sessionID, activeSessionID == sessionID {
            return false
        }

        return activeSession.activeConnectionID != nil
    }

    private func busyActions(for connectionID: UUID) throws -> [HostAction] {
        [
            .send(
                connectionID: connectionID,
                envelope: try makeUnauthenticatedEnvelope(body: .error(ProtocolError(code: "session_busy", message: "Another controller is active", recoverable: true)))
            ),
            .closeConnection(connectionID)
        ]
    }

    private func purgeExpiredSessions(now: Date) {
        let expiredIDs = sessions.values
            .filter { $0.activeConnectionID == nil && now.timeIntervalSince($0.lastSeenAt) > resumeWindow }
            .map(\.id)

        for sessionID in expiredIDs {
            sessions.removeValue(forKey: sessionID)
            if activeSessionID == sessionID {
                activeSessionID = nil
            }
        }
    }
}
