import Foundation
import Network
import T3CodeCommunication

public protocol HostMessageRouting: AnyObject {
    func handlePrompt(_ request: PromptRequest, sessionID: UUID)
    func handleCodeEdit(_ edit: CodeEdit, sessionID: UUID)
    func handleExecution(_ command: ExecutionCommand, sessionID: UUID)
}

public enum HostTransportSecurity {
    case plainTCP
    case tls(makeOptions: @Sendable () -> NWProtocolTLS.Options)
}

public struct HostListenerConfiguration {
    public let serviceType: String
    public let displayName: String
    public let port: UInt16?
    public let security: HostTransportSecurity
    public let queue: DispatchQueue

    public init(
        serviceType: String = "_t3sidecar._tcp",
        displayName: String = ProcessInfo.processInfo.hostName,
        port: UInt16? = nil,
        security: HostTransportSecurity = .plainTCP,
        queue: DispatchQueue = .main
    ) {
        self.serviceType = serviceType
        self.displayName = displayName
        self.port = port
        self.security = security
        self.queue = queue
    }

    var txtRecord: NWTXTRecord {
        NWTXTRecord([
            "proto": "1",
            "name": displayName,
            "requiresPairing": "1",
            "sessionMode": "single",
            "security": securityLabel
        ])
    }

    private var securityLabel: String {
        switch security {
        case .plainTCP:
            "tcp"
        case .tls:
            "tls"
        }
    }

    func makeParameters() -> NWParameters {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true

        switch security {
        case .plainTCP:
            return NWParameters(tls: nil, tcp: tcp)
        case .tls(let makeOptions):
            return NWParameters(tls: makeOptions(), tcp: tcp)
        }
    }
}

@MainActor
public final class HostListener {
    private let configuration: HostListenerConfiguration
    private let router: any HostMessageRouting
    private let coordinator: HostSessionCoordinator

    private var listener: NWListener?
    private var connections: [UUID: NWConnection]

    public init(
        configuration: HostListenerConfiguration = HostListenerConfiguration(),
        pairingValidator: any PairingCodeValidating,
        router: any HostMessageRouting,
        tokenGenerator: any TokenGenerating = RandomTokenGenerator(),
        resumeWindow: TimeInterval = 10 * 60
    ) {
        self.configuration = configuration
        self.router = router
        self.coordinator = HostSessionCoordinator(
            pairingValidator: pairingValidator,
            tokenGenerator: tokenGenerator,
            serverName: configuration.displayName,
            resumeWindow: resumeWindow
        )
        self.connections = [:]
    }

    public func start() throws {
        let parameters = configuration.makeParameters()

        if let port = configuration.port, let resolvedPort = NWEndpoint.Port(rawValue: port) {
            listener = try NWListener(using: parameters, on: resolvedPort)
        } else {
            listener = try NWListener(using: parameters)
        }

        listener?.service = NWListener.Service(
            name: configuration.displayName,
            type: configuration.serviceType,
            domain: nil,
            txtRecord: configuration.txtRecord
        )
        listener?.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            Task { @MainActor in
                self.accept(connection)
            }
        }
        listener?.start(queue: configuration.queue)
    }

    public func stop() {
        listener?.cancel()
        listener = nil

        for connection in connections.values {
            connection.cancel()
        }
        connections.removeAll()
    }

    public func sendStreamStart(_ start: StreamStart, to sessionID: UUID) {
        emit(try? coordinator.makeServerStreamStart(start, to: sessionID))
    }

    public func sendStreamChunk(_ chunk: StreamChunk, to sessionID: UUID) {
        emit(try? coordinator.makeServerStreamChunk(chunk, to: sessionID))
    }

    public func sendStreamEnd(_ end: StreamEnd, to sessionID: UUID) {
        emit(try? coordinator.makeServerStreamEnd(end, to: sessionID))
    }

    private func accept(_ connection: NWConnection) {
        let connectionID = UUID()
        connections[connectionID] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            Task { @MainActor in
                switch state {
                case .ready:
                    self.receiveLoop(connectionID: connectionID, connection: connection)
                case .failed, .cancelled:
                    self.coordinator.detach(connectionID: connectionID)
                    self.connections.removeValue(forKey: connectionID)
                default:
                    break
                }
            }
        }

        connection.start(queue: configuration.queue)
    }

    private func receiveLoop(connectionID: UUID, connection: NWConnection) {
        FrameCodec.receiveNext(from: connection) { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .success(let envelope):
                    do {
                        let actions = try self.coordinator.receive(envelope, from: connectionID)
                        self.execute(actions)
                        self.receiveLoop(connectionID: connectionID, connection: connection)
                    } catch {
                        connection.cancel()
                    }
                case .failure:
                    self.coordinator.detach(connectionID: connectionID)
                    self.connections.removeValue(forKey: connectionID)
                    connection.cancel()
                }
            }
        }
    }

    private func execute(_ actions: [HostAction]) {
        for action in actions {
            switch action {
            case .send(let connectionID, let envelope):
                send(envelope, to: connectionID)
            case .closeConnection(let connectionID):
                connections[connectionID]?.cancel()
                connections.removeValue(forKey: connectionID)
            case .routePrompt(let sessionID, let request):
                router.handlePrompt(request, sessionID: sessionID)
            case .routeCodeEdit(let sessionID, let edit):
                router.handleCodeEdit(edit, sessionID: sessionID)
            case .routeExecution(let sessionID, let command):
                router.handleExecution(command, sessionID: sessionID)
            }
        }
    }

    private func emit(_ action: HostAction?) {
        guard let action else { return }
        execute([action])
    }

    private func send(_ envelope: Envelope, to connectionID: UUID) {
        guard let connection = connections[connectionID], let data = try? FrameCodec.encode(envelope) else {
            return
        }

        connection.send(content: data, completion: .contentProcessed { _ in })
    }
}
