import Foundation
import Testing
@testable import T3CodeHost
import T3CodeCommunication

private final class PairingValidatorStub: PairingCodeValidating {
    var isValid = true

    func validate(_ code: String) -> Bool {
        isValid && code == "123456"
    }
}

private struct TokenGeneratorStub: TokenGenerating {
    let token: String

    func makeToken() -> String {
        token
    }
}

@Test
func helloCreatesSessionAndReturnsHelloAck() throws {
    let validator = PairingValidatorStub()
    let coordinator = HostSessionCoordinator(
        pairingValidator: validator,
        tokenGenerator: TokenGeneratorStub(token: "resume-token"),
        serverName: "t3code"
    )
    let connectionID = UUID()
    let hello = try Envelope(
        sessionID: nil,
        sequence: 1,
        body: .hello(Hello(clientName: "iPhone", clientPlatform: "iOS", pairingCode: "123456", protocolVersion: ProtocolConfig.version))
    )

    let actions = try coordinator.receive(hello, from: connectionID)

    #expect(actions.count == 1)
    guard case .send(_, let envelope) = actions[0],
          case .helloAck(let ack) = envelope.body else {
        Issue.record("Expected helloAck")
        return
    }

    #expect(ack.accepted)
    #expect(ack.resumeToken == "resume-token")
    #expect(ack.serverName == "t3code")
}

@Test
func duplicateRequestReturnsSameAckWithoutRoutingAgain() throws {
    let validator = PairingValidatorStub()
    let coordinator = HostSessionCoordinator(
        pairingValidator: validator,
        tokenGenerator: TokenGeneratorStub(token: "resume-token"),
        serverName: "t3code"
    )
    let connectionID = UUID()
    let hello = try Envelope(
        sessionID: nil,
        sequence: 1,
        body: .hello(Hello(clientName: "iPhone", clientPlatform: "iOS", pairingCode: "123456", protocolVersion: ProtocolConfig.version))
    )
    let helloActions = try coordinator.receive(hello, from: connectionID)
    guard case .send(_, let helloEnvelope) = helloActions[0],
          case .helloAck(let helloAck) = helloEnvelope.body,
          let sessionID = helloAck.sessionID else {
        Issue.record("Expected a session")
        return
    }

    let requestID = UUID()
    let prompt = PromptRequest(requestID: requestID, prompt: "Test", workingDirectory: nil, conversationID: nil)
    let first = try coordinator.receive(
        Envelope(
            sessionID: sessionID,
            sequence: 2,
            acknowledgesRemoteSequence: 1,
            body: .promptRequest(prompt)
        ),
        from: connectionID
    )
    let second = try coordinator.receive(
        Envelope(
            sessionID: sessionID,
            sequence: 3,
            acknowledgesRemoteSequence: 1,
            body: .promptRequest(prompt)
        ),
        from: connectionID
    )

    #expect(first.count == 2)
    #expect(second.count == 1)
    guard case .send(_, let duplicateAckEnvelope) = second[0],
          case .requestAck(let duplicateAck) = duplicateAckEnvelope.body else {
        Issue.record("Expected duplicate request ack")
        return
    }

    #expect(duplicateAck.requestID == requestID)
    #expect(duplicateAck.accepted)
}

@Test
func resumeReplaysBufferedMessagesAfterAcknowledgedSequence() throws {
    let validator = PairingValidatorStub()
    let coordinator = HostSessionCoordinator(
        pairingValidator: validator,
        tokenGenerator: TokenGeneratorStub(token: "resume-token"),
        serverName: "t3code"
    )
    let firstConnectionID = UUID()
    let hello = try Envelope(
        sessionID: nil,
        sequence: 1,
        body: .hello(Hello(clientName: "iPhone", clientPlatform: "iOS", pairingCode: "123456", protocolVersion: ProtocolConfig.version))
    )
    let helloActions = try coordinator.receive(hello, from: firstConnectionID)
    guard case .send(_, let helloEnvelope) = helloActions[0],
          case .helloAck(let helloAck) = helloEnvelope.body,
          let sessionID = helloAck.sessionID else {
        Issue.record("Expected helloAck")
        return
    }

    _ = try coordinator.makeServerStreamStart(StreamStart(streamID: UUID(), source: .modelResponse, correlationID: UUID()), to: sessionID)
    _ = try coordinator.makeServerStreamChunk(StreamChunk(streamID: UUID(), index: 0, text: "hello", isFinalChunk: false), to: sessionID)
    _ = try coordinator.makeServerStreamEnd(StreamEnd(exitCode: nil, summary: "done", streamID: UUID()), to: sessionID)

    coordinator.detach(connectionID: firstConnectionID)

    let secondConnectionID = UUID()
    let resume = try Envelope(
        sessionID: sessionID,
        sequence: 4,
        body: .resume(Resume(sessionID: sessionID, resumeToken: "resume-token", lastAppliedServerSequence: 1, protocolVersion: ProtocolConfig.version))
    )
    let actions = try coordinator.receive(resume, from: secondConnectionID)

    #expect(actions.count == 4)
    guard case .send(_, let resumeEnvelope) = actions[0],
          case .resumeAck(let resumeAck) = resumeEnvelope.body else {
        Issue.record("Expected resumeAck")
        return
    }

    #expect(resumeAck.accepted)
    let replayKinds = actions.compactMap { action -> MessageKind? in
        guard case .send(_, let envelope) = action else { return nil }
        return envelope.kind
    }
    #expect(replayKinds == [.resumeAck, .streamStart, .streamChunk, .streamEnd])
}

@Test
func secondControllerIsRejectedWhileActiveSessionExists() throws {
    let validator = PairingValidatorStub()
    let coordinator = HostSessionCoordinator(
        pairingValidator: validator,
        tokenGenerator: TokenGeneratorStub(token: "resume-token"),
        serverName: "t3code"
    )
    let firstConnectionID = UUID()
    let secondConnectionID = UUID()
    let hello = try Envelope(
        sessionID: nil,
        sequence: 1,
        body: .hello(Hello(clientName: "iPhone", clientPlatform: "iOS", pairingCode: "123456", protocolVersion: ProtocolConfig.version))
    )

    _ = try coordinator.receive(hello, from: firstConnectionID)
    let actions = try coordinator.receive(hello, from: secondConnectionID)

    #expect(actions.count == 2)
    guard case .send(_, let errorEnvelope) = actions[0],
          case .error(let errorPayload) = errorEnvelope.body else {
        Issue.record("Expected session_busy error")
        return
    }

    #expect(errorPayload.code == "session_busy")
    #expect(actions[1] == .closeConnection(secondConnectionID))
}
