// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract GrantVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 6522688558200802542471481890099359929224757943379388312246275758452828330122;
    uint256 constant deltax2 = 8884738414898880215194974823358721621173852927490182725028598284933051983322;
    uint256 constant deltay1 = 19140189690451954615033228557684257031551742983757860626451548561483097197743;
    uint256 constant deltay2 = 16062706568110043462444750535513332944186635790096979537875850163753648719075;

    
    uint256 constant IC0x = 621890849058725320039278011415804123025758513443680672212387411271967759750;
    uint256 constant IC0y = 20102354288616737137676839317871497575047819558549358752022376360822744450032;
    
    uint256 constant IC1x = 20500062907778987664815318369397184456547729541967735848306985653215943279609;
    uint256 constant IC1y = 18371150959362966574672789707051742210436859583237589929416071795470249533298;
    
    uint256 constant IC2x = 15345592569260803645162072986276110235232608768223327542934211111697059861658;
    uint256 constant IC2y = 3271490103584857407357269574378546894948944652651616370459390097929448977215;
    
    uint256 constant IC3x = 20736849508488943069142115293989467833096409105445440656989337065971698892189;
    uint256 constant IC3y = 16715586959884719039880641309352098306931500636133970678919746329148761528597;
    
    uint256 constant IC4x = 15842010811277731611074945069003102045949687853965603327870194502116388193113;
    uint256 constant IC4y = 2007164690482221966078565431577760775039051225093049068350940214871196001927;
    
    uint256 constant IC5x = 913877041513406453236989342060826888253673197862200773167395541223965331408;
    uint256 constant IC5y = 20433952175121520400759181896391715944761499419296176800994571235969910882662;
    
    uint256 constant IC6x = 3038090050613437144821906898201468150034855200380196721374571065280006674870;
    uint256 constant IC6y = 12049632444966836300771064268283951857313321050219424283376396818106342108609;
    
    uint256 constant IC7x = 13011122687879053080080173518060229616504876810593070615872274898972898322613;
    uint256 constant IC7y = 8805563145304434779152193346035217039718165951303787565821260442266969914850;
    
    uint256 constant IC8x = 5649562137997540909538910874562113932833980368109039213583266829048689760340;
    uint256 constant IC8y = 18069541066204956841053589932980760283724958045492551064611957214333112660683;
    
    uint256 constant IC9x = 16178747942362413546773034736178833569260820584039140340241313775872823773890;
    uint256 constant IC9y = 19293730552440311214880011185764257713041841635908958981071943015999462069582;
    
    uint256 constant IC10x = 12838258592045198667526447119260143083800386488426762811545255808096001412470;
    uint256 constant IC10y = 10516124232945039600311537523039843464663710200961111965633963213316938579430;
    
    uint256 constant IC11x = 10750355931991359566312724282010580999903374359361287649595556867381494549733;
    uint256 constant IC11y = 3899635288870096288865476644074716312902189935123836010839087738348007608548;
    
    uint256 constant IC12x = 18144529857196564528067993695893675871390391712713295714917982215673445635526;
    uint256 constant IC12y = 6410190697103223027829808582151218776818489032301358609234604298365989584676;
    
    uint256 constant IC13x = 16555613110387566650522445260468786030965354933870059993564229175147856841949;
    uint256 constant IC13y = 21283590546337098323176853377278170103698781899210996993432658321839862029010;
    
    uint256 constant IC14x = 11286111354380606675505457208738910978645650106117876885918439162754270474349;
    uint256 constant IC14y = 3685024444394359701644325041888837746918867497247121584572517785764331803714;
    
    uint256 constant IC15x = 11854454095061981665336769413373428978053159226597754187193210589972897760946;
    uint256 constant IC15y = 10949865588302923104185840847137832520005544423942136515608677476603170201751;
    
    uint256 constant IC16x = 14843386697248197834258357253152898129942606367205819688534643134036375739687;
    uint256 constant IC16y = 10031370229621689101815953453748378846838140777110940410169719272745497700709;
    
    uint256 constant IC17x = 19416761318618527233727856243510241717650546037110644191690796719985392457396;
    uint256 constant IC17y = 17649681916393475024163714410094704860105329663506821221080790914504268322224;
    
    uint256 constant IC18x = 615996266846093185433495410819361407880008360419811428598363324740685836438;
    uint256 constant IC18y = 4174758177347901803215136393934393522540818807033764804260709207689157890854;
    
    uint256 constant IC19x = 20603690831912157395548178390587645341686867572960671941337810597086069426141;
    uint256 constant IC19y = 10411044933658889817884747065266428476876964199782509860684480299564161591278;
    
    uint256 constant IC20x = 14493137216933443804614936728897445851676183105911948999417824506413140507004;
    uint256 constant IC20y = 9304873679250066015547934758125592223894234948830024712921329614974277550994;
    
    uint256 constant IC21x = 17110918003557972748545185837509104303878804525518453356615364421942481264849;
    uint256 constant IC21y = 4511335245493549013656073856453279781598456631550900454156448141677200569675;
    
    uint256 constant IC22x = 1845824613043098283310303326550046251139656331936603340485254372028315828599;
    uint256 constant IC22y = 12609133909834307344904424573013778312255197639668195688035763040904678896016;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[22] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
